# agent -- the HTTP surface the web app talks to. Python port of
# ../../e2e-travel-concierge/agent/server.ts.
#
# Public surface (browser): GET /personas, POST /chat, POST /onboard-agent, and
# POST /revoke-agent for the guided revocation demo. The browser may carry a
# one-time Console-generated onboarding token, but it never receives a
# VC, VP, private key, admin key, or persisted credential material.
#
# Runtime onboarding consumes a token minted by HelixID Console. This app only
# keeps local persona convenience state (the manifest only); HelixID
# remains the source of truth for enrollment, scopes, revocation, and audit.
# Route contracts (paths, JSON shapes) match server.ts exactly, since the
# static web/ frontend is reused unchanged.

from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from flask import Flask, jsonify, request

from agent.chat.llm_error import LlmError
from agent.chat.run_chat_turn import run_chat_turn
from config import SCOPES, env
from helix_sdk.client import HelixClient
from helix_sdk.proof import _to_iso_z
from personas.enroll import EnrollInput, enroll_persona
from personas.store import add_persona, get_persona, has_persona, list_personas, load_personas, update_persona
from personas.types import Persona

DELEGATION_SOURCE_ID = "delegation-planner"
DELEGATION_TARGET_ID = "delegation-research"

app = Flask(__name__)


def _now_iso() -> str:
    return _to_iso_z(datetime.now(timezone.utc))


# ── Delegation-credential matching helpers (server.ts's free functions) ────


def _vc_scopes(vc: Dict[str, Any]) -> List[str]:
    subject = vc.get("credentialSubject") or {}
    scopes = subject.get("privilegeScopes")
    return [s for s in scopes if isinstance(s, str)] if isinstance(scopes, list) else []


def _vc_max_delegation_depth(vc: Dict[str, Any]) -> int:
    subject = vc.get("credentialSubject") or {}
    value = subject.get("maxDelegationDepth")
    return value if isinstance(value, int) else 0


def _vc_delegation_depth(vc: Dict[str, Any]) -> int:
    subject = vc.get("credentialSubject") or {}
    value = subject.get("delegationDepth")
    return value if isinstance(value, int) else 0


def _credential_matches(vc: Dict[str, Any], scopes: List[str], max_delegation_depth: int) -> bool:
    available = _vc_scopes(vc)
    expected = set(scopes)
    return (
        len(available) == len(scopes)
        and all(s in expected for s in available)
        and _vc_max_delegation_depth(vc) >= max_delegation_depth
    )


def _is_issuer_backed_root_credential(vc: Dict[str, Any]) -> bool:
    subject = vc.get("credentialSubject") or {}
    return vc.get("issuer") != subject.get("id") and _vc_delegation_depth(vc) == 0


def _can_satisfy_delegation_persona(vc: Dict[str, Any], scopes: List[str], max_delegation_depth: int) -> bool:
    if not _credential_matches(vc, scopes, max_delegation_depth):
        return False
    return max_delegation_depth <= 0 or _is_issuer_backed_root_credential(vc)


def _active_credentials(client: HelixClient, agent_did: str) -> List[Dict[str, Any]]:
    """Every active credential the platform holds for an agent.

    Replaces reading wallet.credentials: self-custody is retired, so the
    platform is the only place a persona's credentials exist.
    """
    out: List[Dict[str, Any]] = []
    for summary in client.list_vcs(subject_did=agent_did, status="active"):
        vc = (client.get_vc(summary["vcId"]) or {}).get("vc")
        if vc:
            out.append(vc)
    return out


def _find_delegation_source_credential(credentials: List[Dict[str, Any]], scopes: List[str]) -> Optional[Dict[str, Any]]:
    candidates = []
    for vc in credentials:
        available = set(_vc_scopes(vc))
        if all(s in available for s in scopes) and _vc_delegation_depth(vc) + 1 <= _vc_max_delegation_depth(vc):
            candidates.append(vc)
    root = next((vc for vc in candidates if _is_issuer_backed_root_credential(vc)), None)
    return root if root is not None else (candidates[0] if candidates else None)


@app.get("/health")
def health():
    return jsonify({"status": "ok", "provider": env.llm_provider})


# ── Public: discover selectable agents (safe metadata only) ────────────────
@app.get("/personas")
def get_personas():
    return jsonify({"personas": list_personas()})


# ── Public: chat as a selected persona ─────────────────────────────────────
@app.post("/chat")
def chat():
    body = request.get_json(silent=True) or {}
    persona_id = body.get("personaId")
    message = body.get("message")
    conversation_id = body.get("conversationId") or "default"

    if not message or not isinstance(message, str):
        return jsonify({"error": "message is required"}), 400
    if not persona_id or not isinstance(persona_id, str):
        return jsonify({"error": "personaId is required"}), 400
    persona = get_persona(persona_id)
    if not persona:
        return jsonify({"error": f"Unknown persona: {persona_id}"}), 404

    try:
        reply = run_chat_turn(persona, message, conversation_id)
        return jsonify({"reply": reply, "personaId": persona_id})
    except LlmError as error:
        print(f"[Agent] chat turn failed: {error.provider} {error.code} {error.cause}")
        return (
            jsonify(
                {
                    "error": error.code,
                    "message": error.user_message,
                    "provider": error.provider,
                    "retryAfterSeconds": error.retry_after_seconds,
                }
            ),
            error.http_status,
        )
    except Exception as error:  # noqa: BLE001
        print(f"[Agent] chat turn failed: {error}")
        return jsonify({"error": "CHAT_FAILED", "message": "The agent could not complete that request."}), 500


# ── Public: consume a Console-generated token and enroll another agent ─────
def _slugify(value: str) -> str:
    slug = re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", value.strip().lower()))
    return slug if re.match(r"^[a-z]", slug) else f"agent-{slug or int(time.time() * 1000)}"


def _unique_persona_id(base: str) -> str:
    if not has_persona(base):
        return base
    for i in range(2, 1000):
        candidate = f"{base}-{i}"
        if not has_persona(candidate):
            return candidate
    return f"{base}-{int(time.time() * 1000)}"


@app.post("/onboard-agent")
def onboard_agent():
    body = request.get_json(silent=True) or {}
    bootstrap_token = body.get("bootstrapToken")
    display_name = body.get("displayName")
    persona_id = body.get("personaId")

    if not bootstrap_token or not isinstance(bootstrap_token, str):
        return jsonify({"error": "bootstrapToken is required"}), 400

    resolved_display_name = display_name.strip() if isinstance(display_name, str) and display_name.strip() else (
        f"Agent {datetime.now(timezone.utc).strftime('%H:%M:%S')}"
    )
    resolved_persona_id = (
        persona_id.strip() if isinstance(persona_id, str) and persona_id.strip() else _unique_persona_id(_slugify(resolved_display_name))
    )

    if not re.match(r"^[a-z][a-z0-9-]*$", resolved_persona_id):
        return jsonify({"error": "personaId must match ^[a-z][a-z0-9-]*$"}), 400
    if has_persona(resolved_persona_id):
        return jsonify({"error": f'persona "{resolved_persona_id}" already exists'}), 409

    try:
        result = enroll_persona(
            EnrollInput(id=resolved_persona_id, display_name=resolved_display_name, scopes=[], bootstrap_token=bootstrap_token)
        )
        add_persona(result.persona)
        print(f'[Agent] Onboarded persona "{result.persona.id}" ({", ".join(result.persona.scopes)}) DID {result.did}, VC {result.vc_id}.')
        return jsonify({"persona": result.persona.to_public()}), 201
    except Exception as error:  # noqa: BLE001
        print(f"[Agent] onboard failed: {error}")
        return jsonify({"error": str(error) or "onboard_failed"}), 502


# ── Demo admin action: revoke the selected persona's real credential ───────
@app.post("/revoke-agent")
def revoke_agent():
    body = request.get_json(silent=True) or {}
    persona_id = body.get("personaId")
    if not persona_id or not isinstance(persona_id, str):
        return jsonify({"error": "personaId is required"}), 400

    persona = get_persona(persona_id)
    if not persona:
        return jsonify({"error": f"Unknown persona: {persona_id}"}), 404

    try:
        client = HelixClient(env.helix_api_url, admin_api_key=env.admin_api_key)
        credentials = _active_credentials(client, persona.agent_did)
        vc = credentials[0] if credentials else None
        if not vc or not vc.get("id"):
            return jsonify({"error": f'Persona "{persona_id}" has no credential to revoke'}), 409

        result = client.revoke_vc(vc["id"])
        print(f'[Agent] Revoked persona "{persona.id}" credential {vc["id"]}.')
        return jsonify(
            {
                "persona": persona.to_public(),
                "vcId": vc["id"],
                "revoked": True,
                "revokedAt": result.get("revokedAt") or _now_iso(),
            }
        )
    except Exception as error:  # noqa: BLE001
        print(f"[Agent] revoke failed: {error}")
        return jsonify({"error": str(error) or "revoke_failed"}), 502


# ── Use case 4: create two agents and delegate narrowed authority ──────────
def _ensure_delegation_persona(persona_id: str, display_name: str, scopes: List[str], max_delegation_depth: int) -> Persona:
    existing = get_persona(persona_id)
    if existing:
        client = HelixClient(env.helix_api_url, admin_api_key=env.admin_api_key)
        matching = next(
            (
                vc
                for vc in _active_credentials(client, existing.agent_did)
                if _can_satisfy_delegation_persona(vc, scopes, max_delegation_depth)
            ),
            None,
        )
        if matching is not None:
            if (
                existing.active_credential_id != matching.get("id")
                or existing.delegated_from_persona_id
                or existing.delegated_scopes
            ):
                return update_persona(
                    existing.id, scopes=scopes, active_credential_id=matching.get("id"), _clear_delegation=True
                )
            return existing
        result = enroll_persona(
            EnrollInput(id=persona_id, display_name=display_name, scopes=scopes, max_delegation_depth=max_delegation_depth)
        )
        updated = update_persona(
            existing.id, scopes=result.persona.scopes, active_credential_id=result.vc_id, _clear_delegation=True
        )
        print(f'[Agent] Refreshed delegation demo persona "{updated.id}" DID {result.did}, VC {result.vc_id}.')
        return updated

    result = enroll_persona(
        EnrollInput(id=persona_id, display_name=display_name, scopes=scopes, max_delegation_depth=max_delegation_depth)
    )
    add_persona(result.persona)
    print(f'[Agent] Created delegation demo persona "{result.persona.id}" DID {result.did}, VC {result.vc_id}.')
    return result.persona


@app.post("/delegation-demo-agents")
def delegation_demo_agents():
    try:
        source = _ensure_delegation_persona(
            DELEGATION_SOURCE_ID, "Planner Agent", [SCOPES["FLIGHTS_READ"], SCOPES["FLIGHTS_BOOK"]], 1
        )
        target = _ensure_delegation_persona(DELEGATION_TARGET_ID, "Research Agent", [], 0)
        return jsonify({"source": source.to_public(), "target": target.to_public()}), 201
    except Exception as error:  # noqa: BLE001
        print(f"[Agent] delegation demo setup failed: {error}")
        return jsonify({"error": str(error) or "delegation_setup_failed"}), 502


@app.post("/delegate-agent")
def delegate_agent():
    body = request.get_json(silent=True) or {}
    from_persona_id = body.get("fromPersonaId") or DELEGATION_SOURCE_ID
    to_persona_id = body.get("toPersonaId") or DELEGATION_TARGET_ID
    scopes = body.get("scopes") if isinstance(body.get("scopes"), list) and body.get("scopes") else [SCOPES["FLIGHTS_READ"]]

    from_persona = get_persona(from_persona_id)
    to_persona = get_persona(to_persona_id)
    if not from_persona:
        return jsonify({"error": f"Unknown source persona: {from_persona_id}"}), 404
    if not to_persona:
        return jsonify({"error": f"Unknown target persona: {to_persona_id}"}), 404

    try:
        client = HelixClient(env.helix_api_url, admin_api_key=env.admin_api_key)
        from_vc = _find_delegation_source_credential(
            _active_credentials(client, from_persona.agent_did), scopes
        )
        if from_vc is None:
            return (
                jsonify(
                    {
                        "error": (
                            f"{from_persona.display_name} does not have a credential that can delegate {', '.join(scopes)}. "
                            'Click "Create demo agents" to refresh the demo credentials, then delegate again.'
                        )
                    }
                ),
                409,
            )
        # delegate_authority() authorizes the API to sign on the delegator's
        # behalf. The wallet-based delegate() needed the delegator's own
        # private key, which no longer exists outside the server. The platform
        # persists the delegated credential, so there is nothing to store on
        # the target's side.
        child_vc = client.delegate_authority(
            from_persona.agent_did,
            to_persona.agent_did,
            scopes,
            60 * 60,
            vc_id=from_vc.get("id"),
        )

        updated_target = update_persona(
            to_persona.id, active_credential_id=child_vc.get("id"), delegated_from_persona_id=from_persona.id, delegated_scopes=scopes
        )

        print(f'[Agent] Delegated {", ".join(scopes)} from "{from_persona.id}" to "{to_persona.id}" via {child_vc.get("id")}.')
        return jsonify(
            {
                "from": from_persona.to_public(),
                "to": updated_target.to_public(),
                "delegatedCredentialId": child_vc.get("id"),
                "scopes": scopes,
            }
        )
    except Exception as error:  # noqa: BLE001
        print(f"[Agent] delegation failed: {error}")
        return jsonify({"error": str(error) or "delegation_failed"}), 502


def create_app() -> Flask:
    load_personas()
    return app


if __name__ == "__main__":
    create_app()
    print(
        f"[Agent] Travel concierge listening on :{env.agent_port} "
        f"(LLM_PROVIDER={env.llm_provider}, personas: {', '.join(p['id'] for p in list_personas()) or 'none'})."
    )
    app.run(host="0.0.0.0", port=env.agent_port)
