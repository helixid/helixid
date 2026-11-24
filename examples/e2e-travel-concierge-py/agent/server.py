# agent -- the HTTP surface the web app talks to. Python port of
# ../../e2e-travel-concierge/agent/server.ts.
#
# Public surface (browser): GET /personas, POST /chat, POST /onboard-agent,
# POST /revoke-agent and the delegation demo routes, plus POST /call-tool for
# the no-LLM check. The browser may carry a one-time Console-generated
# enrollment token, but it never receives a key, a credential, a request proof
# or the admin key.
#
# KYA-OS throughout (helixid is self custody): each persona's key lives in its
# own key directory on the shared volume, written by helix init; it signs the
# persona's request proofs and the hops it delegates. Route contracts (paths,
# JSON shapes) match server.ts exactly, since the static web/ frontend is
# reused unchanged.

from __future__ import annotations

import re
import time
from datetime import datetime, timedelta, timezone
from typing import List

from flask import Flask, jsonify, request

from agent.chat.llm_error import LlmError
from agent.chat.run_chat_turn import run_chat_turn
from agent.tools.protected_call import call_protected_tool
from config import SCOPES, env
from helixid import HelixRefusal, admin
from personas.enroll import EnrollInput, enroll_persona
from personas.keys import delegate_hop
from personas.store import add_persona, get_persona, has_persona, list_personas, load_personas, update_persona
from personas.types import Persona

DELEGATION_SOURCE_ID = "delegation-planner"
DELEGATION_TARGET_ID = "delegation-research"
# How long Planner's delegation to Research lasts.
DELEGATION_SECONDS = 60 * 60

app = Flask(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _refusal(error: Exception, fallback: str):
    print(f"[Agent] {fallback}: {error}")
    if isinstance(error, HelixRefusal):
        return jsonify({"error": f"{error.code}: {error}", "code": error.code}), (error.status if error.status >= 400 else 502)
    return jsonify({"error": str(error) or fallback}), 502


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


# ── Public: consume a Console-generated enrollment token, enroll another agent ──
# helix init runs here: the agent's key is generated in this process and only
# its public key goes to HelixID. Its responsible party then roots its chain at
# the service with what its card attests.
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
        return _refusal(error, "onboard failed")


# ── Public: call a protected tool directly, without the LLM ───────────────
@app.post("/call-tool")
def call_tool():
    body = request.get_json(silent=True) or {}
    persona = get_persona(body.get("personaId") or "")
    if not persona:
        return jsonify({"error": f"Unknown persona: {body.get('personaId')}"}), 404
    tool_name = body.get("toolName")
    if not tool_name or not isinstance(tool_name, str):
        return jsonify({"error": "toolName is required (search_flights or book_flight)"}), 400
    try:
        result = call_protected_tool(persona, tool_name, body.get("input") or {})
        return jsonify(result.to_dict()), (200 if result.success else 403)
    except Exception as error:  # noqa: BLE001
        return _refusal(error, "call-tool failed")


# ── Demo admin action: revoke the selected agent ───────────────────────────
# Its identity credential (the revocation entry on its Entity Card) and the
# root hop its responsible party issued, which takes every hop below it.
@app.post("/revoke-agent")
def revoke_agent():
    body = request.get_json(silent=True) or {}
    persona_id = body.get("personaId")
    if not persona_id or not isinstance(persona_id, str):
        return jsonify({"error": "personaId is required"}), 400
    persona = get_persona(persona_id)
    if not persona:
        return jsonify({"error": f"Unknown persona: {persona_id}"}), 404
    if not persona.vc_id:
        return jsonify({"error": f'Persona "{persona_id}" has no credential to revoke'}), 409
    try:
        result = admin("POST", f"/v1/vcs/{persona.vc_id}/revoke") or {}
        root = (persona.chain or [None])[0]
        revoked_hops: List[str] = []
        if root is not None:
            revoked_hops = (admin("DELETE", f"/v1/grants/{root['id']}") or {}).get("revokedVcIds") or [root["id"]]
        revoked_at = result.get("revokedAt") or _now_iso()
        updated = update_persona(persona.id, revoked_at=revoked_at)
        print(f'[Agent] Revoked persona "{persona.id}": credential {persona.vc_id} and {len(revoked_hops)} hop(s).')
        return jsonify({"persona": updated.to_public(), "vcId": persona.vc_id, "revokedHops": revoked_hops, "revoked": True, "revokedAt": revoked_at})
    except Exception as error:  # noqa: BLE001
        return _refusal(error, "revoke failed")


# ── Use case 4: two agents, and narrowed authority delegated between them ──
def _ensure_delegation_persona(persona_id: str, display_name: str, scopes: List[str], own_authority: bool) -> Persona:
    existing = get_persona(persona_id)
    if existing is not None and not existing.revoked_at:
        # A fresh run starts from the persona's own state: no delegation received.
        if own_authority:
            return existing
        return update_persona(existing.id, chain=None, delegated_from_persona_id=None, delegated_scopes=None)
    result = enroll_persona(EnrollInput(id=persona_id, display_name=display_name, scopes=scopes, own_authority=own_authority))
    if existing is not None:
        return update_persona(
            existing.id,
            scopes=result.persona.scopes,
            agent_did=result.persona.agent_did,
            vc_id=result.persona.vc_id,
            chain=result.persona.chain,
            status_list=None,
            revoked_at=None,
            delegated_from_persona_id=None,
            delegated_scopes=None,
        )
    add_persona(result.persona)
    print(f'[Agent] Created delegation demo persona "{result.persona.id}" DID {result.did}, VC {result.vc_id}.')
    return result.persona


@app.post("/delegation-demo-agents")
def delegation_demo_agents():
    try:
        source = _ensure_delegation_persona(DELEGATION_SOURCE_ID, "Planner Agent", [SCOPES["FLIGHTS_READ"], SCOPES["FLIGHTS_BOOK"]], True)
        # Attested for both scopes, but no authority of its own at the service.
        target = _ensure_delegation_persona(DELEGATION_TARGET_ID, "Research Agent", [SCOPES["FLIGHTS_READ"], SCOPES["FLIGHTS_BOOK"]], False)
        return jsonify({"source": source.to_public(), "target": target.to_public()}), 201
    except Exception as error:  # noqa: BLE001
        return _refusal(error, "delegation setup failed")


# The delegator signs a hop to the target under the chain it holds, with its own
# key, on its own status list. The target then carries root -> delegator -> target.
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
    parent = from_persona.chain
    held = set(((parent or [{}])[-1].get("credentialSubject") or {}).get("allowedAction") or [])
    if not parent or not all(scope in held for scope in scopes):
        return (
            jsonify(
                {
                    "error": f'{from_persona.display_name} holds no authority to delegate {", ".join(scopes)}. Click "Create demo agents" to refresh the demo agents, then delegate again.',
                    "code": "SCOPE_ESCALATION_DENIED",
                }
            ),
            409,
        )
    try:
        parent_until = datetime.fromisoformat(parent[-1]["validUntil"].replace("Z", "+00:00"))
        until = min(datetime.now(timezone.utc) + timedelta(seconds=DELEGATION_SECONDS), parent_until)
        valid_until = until.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        hop, status_list = delegate_hop(from_persona, parent, to_persona.agent_did, scopes, valid_until)
        updated_source = update_persona(from_persona.id, status_list=status_list)
        updated_target = update_persona(to_persona.id, chain=[*parent, hop], delegated_from_persona_id=from_persona.id, delegated_scopes=scopes)
        print(f'[Agent] Delegated {", ".join(scopes)} from "{from_persona.id}" to "{to_persona.id}" with hop {hop["id"]}.')
        return jsonify({"from": updated_source.to_public(), "to": updated_target.to_public(), "delegatedHopId": hop["id"], "scopes": scopes, "validUntil": valid_until})
    except Exception as error:  # noqa: BLE001
        return _refusal(error, "delegation failed")


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
