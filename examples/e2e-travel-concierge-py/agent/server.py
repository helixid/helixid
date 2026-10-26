# agent -- the HTTP surface the web app (and curl, for manual testing) talks
# to. Python port of ../e2e-travel-concierge/agent/server.ts.
#
# Every route below is a building block the guided scenarios in the web UI
# combine: onboard agents, call a protected tool (as an agent, optionally on a
# traveler's behalf), record a traveler's consent at a service, revoke a
# credential or a consent, delegate between agents, deactivate an agent's DID,
# and three deliberate attacks (replay, tamper, wrong service).
#
# The browser never receives a private key or the admin key -- agent
# self-custody is retired, so there is no key to receive: the server
# generates and holds it, and every VP is signed via POST /v1/agents/:did/vp
# (see agent/tools/protected_call.py). This app only keeps local convenience
# state (a persona manifest and a grant index); HelixID remains the source of
# truth for enrollment, scopes, consent, revocation, and audit.

from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple
from urllib.parse import quote

import requests
from dotenv import load_dotenv

load_dotenv()

from flask import Flask, jsonify, request  # noqa: E402

from agent.attacks import capture_and_send, present_to_wrong_service, replay, tamper_and_send  # noqa: E402
from agent.chat.llm_error import LlmError  # noqa: E402
from agent.chat.run_chat_turn import run_chat_turn  # noqa: E402
from agent.services import list_services  # noqa: E402
from agent.tools.protected_call import call_protected_tool  # noqa: E402
from config import SERVICES, USERS, env  # noqa: E402
from personas.enroll import EnrollInput, enroll_persona  # noqa: E402
from personas.grants import add_grant, list_grants, mark_grant_revoked  # noqa: E402
from personas.platform import admin_call, describe_api_error  # noqa: E402
from personas.store import add_persona, get_persona, has_persona, list_personas, load_personas, update_persona  # noqa: E402
from personas.types import Persona  # noqa: E402

DELEGATION_PLANNER_ID = "delegation-planner"
DELEGATION_RESEARCH_ID = "delegation-research"
DELEGATION_SCOPES = ["read:catalog", "write:orders"]

app = Flask(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _require_persona(persona_id: Any) -> Tuple[Optional[Persona], Optional[Tuple[Any, int]]]:
    if not persona_id or not isinstance(persona_id, str):
        return None, (jsonify({"error": "personaId is required"}), 400)
    persona = get_persona(persona_id)
    if persona is None:
        return None, (jsonify({"error": f"Unknown persona: {persona_id}"}), 404)
    return persona, None


def _fail(error: Exception, fallback: str):
    print(f"[Agent] {fallback}: {error}", flush=True)
    return jsonify({"success": False, "code": re.sub(r"\W+", "_", fallback).upper(), "detail": str(error) or fallback}), 502


def _refused(result: Dict[str, Any], prefix: str = "Refused by HelixID"):
    """A platform refusal, passed through with its code so the scenario can show it."""
    error = result["body"].get("error") or {}
    code = error.get("code") or f"HTTP_{result['status']}"
    status = result["status"] if result["status"] >= 400 else 502
    return jsonify({"success": False, "code": code, "detail": f"{prefix} [{code}]: {describe_api_error(error, result['status'])}"}), status


@app.get("/health")
def health():
    return jsonify({"status": "ok", "provider": env.llm_provider})


# ── Public: discover selectable agents, services and travelers (safe metadata only) ──
@app.get("/personas")
def get_personas():
    return jsonify({"personas": list_personas()})


@app.get("/services")
def get_services():
    try:
        return jsonify({"services": list_services()})
    except Exception as error:  # noqa: BLE001
        return _fail(error, "services failed")


@app.get("/users")
def get_users():
    return jsonify({"users": list(USERS.values())})


# ── Public: chat as a selected persona, optionally on a traveler's behalf ──
@app.post("/chat")
def chat():
    body = request.get_json(silent=True) or {}
    message = body.get("message")
    if not message or not isinstance(message, str):
        return jsonify({"error": "message is required"}), 400
    persona, failure = _require_persona(body.get("personaId"))
    if failure:
        return failure
    user_id = body.get("userId") if body.get("userId") in USERS else None
    try:
        result = run_chat_turn(persona, message, body.get("conversationId") or "default", user_id=user_id)
        return jsonify({**result, "personaId": persona.id})
    except LlmError as error:
        print(f"[Agent] chat turn failed: {error.provider} {error.code} {error.cause}", flush=True)
        return (
            jsonify({"error": error.code, "message": error.user_message, "provider": error.provider, "retryAfterSeconds": error.retry_after_seconds}),
            error.http_status,
        )
    except Exception as error:  # noqa: BLE001
        print(f"[Agent] chat turn failed: {error}", flush=True)
        return jsonify({"error": "CHAT_FAILED", "message": "The agent could not complete that request."}), 500


# ── Public: call a protected tool directly, bypassing the LLM entirely ─────
@app.post("/call-tool")
def call_tool():
    body = request.get_json(silent=True) or {}
    tool_name = body.get("toolName")
    if not tool_name or not isinstance(tool_name, str):
        return jsonify({"error": "toolName is required (search_flights, book_flight, search_hotels, book_hotel)"}), 400
    persona, failure = _require_persona(body.get("personaId"))
    if failure:
        return failure
    user_id = body.get("userId") if body.get("userId") in USERS else None
    try:
        result = call_protected_tool(persona, tool_name, body.get("input") or {}, user_id=user_id)
        return jsonify(result), (200 if result["success"] else 403)
    except Exception as error:  # noqa: BLE001
        return _fail(error, "call-tool failed")


# ── Public: onboard another agent (enrollment token + POST /v1/onboard) ────
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
    scopes = body.get("scopes")
    # An empty list is allowed on purpose: an agent onboarded with no scopes
    # has an identity but no authority of its own (see the delegation scenarios).
    if not isinstance(scopes, list):
        return jsonify({"error": 'scopes is required, e.g. ["read:catalog"], ["read:catalog","write:orders"], or [] for none'}), 400

    display_name = body.get("displayName")
    resolved_display_name = display_name.strip() if isinstance(display_name, str) and display_name.strip() else f"Agent {datetime.now(timezone.utc).strftime('%H:%M:%S')}"
    persona_id = body.get("personaId")
    resolved_persona_id = persona_id.strip() if isinstance(persona_id, str) and persona_id.strip() else _unique_persona_id(_slugify(resolved_display_name))
    if not re.match(r"^[a-z][a-z0-9-]*$", resolved_persona_id):
        return jsonify({"error": "personaId must match ^[a-z][a-z0-9-]*$"}), 400
    if has_persona(resolved_persona_id):
        return jsonify({"error": f'persona "{resolved_persona_id}" already exists'}), 409

    try:
        max_depth = body.get("maxDelegationDepth")
        group = body.get("group")
        token = body.get("token")
        result = enroll_persona(
            EnrollInput(
                id=resolved_persona_id,
                display_name=resolved_display_name,
                scopes=scopes,
                max_delegation_depth=max_depth if isinstance(max_depth, int) else None,
                group=group if isinstance(group, str) and group else None,
                # Optional one-use enrollment token generated in Console; its scopes win over `scopes`.
                bootstrap_token=token.strip() if isinstance(token, str) and token.strip() else None,
            )
        )
        add_persona(result.persona)
        p = result.persona
        print(f'[Agent] Onboarded persona "{p.id}" ({", ".join(p.scopes) or "no scopes"}) DID {result.did}, VC {result.vc_id}.', flush=True)
        return jsonify({"persona": p.to_public()}), 201
    except Exception as error:  # noqa: BLE001
        return _fail(error, "onboard failed")


# ── Organization action: revoke the persona's own credential ───────────────
@app.post("/revoke-agent")
def revoke_agent():
    persona, failure = _require_persona((request.get_json(silent=True) or {}).get("personaId"))
    if failure:
        return failure
    try:
        # POST /v1/vcs/:vcId/revoke is admin-gated in OSS.
        result = admin_call(f"/v1/vcs/{quote(persona.vc_id, safe='')}/revoke")
        if not result["ok"]:
            return _refused(result)
        revoked_at = result["body"].get("revokedAt") or _now()
        updated = update_persona(persona.id, revoked_at=revoked_at)
        print(f'[Agent] Revoked persona "{persona.id}" credential {persona.vc_id}.', flush=True)
        return jsonify({"success": True, "persona": updated.to_public(), "vcId": persona.vc_id, "revoked": True, "revokedAt": revoked_at, "detail": f"Revoked {persona.display_name}'s credential {persona.vc_id}."})
    except Exception as error:  # noqa: BLE001
        return _fail(error, "revoke failed")


# ── Organization action: retire the agent's whole identity (its DID) ───────
@app.post("/deactivate-agent")
def deactivate_agent():
    persona, failure = _require_persona((request.get_json(silent=True) or {}).get("personaId"))
    if failure:
        return failure
    try:
        # Core's DID lifecycle route (admin-gated). Note: a did:key's document is
        # derived from the DID itself, so verifiers never consult the registry
        # for it -- deactivating a did:key agent records the fact but can't stop
        # its VPs from verifying. See README "Shipped-capability notes".
        result = admin_call(f"/v1/dids/{quote(persona.did, safe='')}/deactivate")
        if not result["ok"]:
            return _refused(result)
        updated = update_persona(persona.id, deactivated_at=_now())
        print(f'[Agent] Deactivated persona "{persona.id}" DID {persona.did}.', flush=True)
        return jsonify({"success": True, "persona": updated.to_public(), "detail": f"Deactivated {persona.display_name}'s DID {persona.did}. Its credential {persona.vc_id} was not revoked."})
    except Exception as error:  # noqa: BLE001
        return _fail(error, "deactivate failed")


# ── Agent-to-agent delegation ──────────────────────────────────────────────
# POST /v1/agents/:did/delegate signs the delegated VC server-side with the
# delegator's server-held key. `fromDelegated` delegates from the credential
# the delegator was itself delegated (a second hop), otherwise from its own
# onboarding credential.
@app.post("/delegate-agent")
def delegate_agent():
    body = request.get_json(silent=True) or {}
    from_id, to_id, scopes = body.get("fromPersonaId"), body.get("toPersonaId"), body.get("scopes")
    if not from_id or not to_id or not isinstance(scopes, list) or not scopes:
        return jsonify({"error": "fromPersonaId, toPersonaId and a non-empty scopes array are required"}), 400
    from_persona, to_persona = get_persona(from_id), get_persona(to_id)
    if from_persona is None:
        return jsonify({"error": f"Unknown persona: {from_id}"}), 404
    if to_persona is None:
        return jsonify({"error": f"Unknown persona: {to_id}"}), 404
    source_vc_id = from_persona.delegated_vc_id if body.get("fromDelegated") else from_persona.vc_id
    if not source_vc_id:
        return jsonify({"success": False, "code": "NO_DELEGATED_CREDENTIAL", "detail": f"{from_persona.display_name} holds no delegated credential to delegate from."}), 400
    expires_in = body.get("expiresIn")
    lifetime = int(expires_in) if isinstance(expires_in, (int, float)) and expires_in > 0 else 3600

    try:
        result = admin_call(
            f"/v1/agents/{quote(from_persona.did, safe='')}/delegate",
            {"to": to_persona.did, "scopes": scopes, "expiresIn": lifetime, "vcId": source_vc_id},
        )
        vc = result["body"].get("delegatedVC")
        if not result["ok"] or not vc:
            print(f'[Agent] Delegation {from_persona.display_name} -> {to_persona.display_name} [{", ".join(scopes)}] refused: {(result["body"].get("error") or {}).get("code") or result["status"]}.', flush=True)
            return _refused(result)
        updated = update_persona(
            to_persona.id,
            delegated_vc_id=vc["id"],
            delegated_scopes=(vc.get("credentialSubject") or {}).get("privilegeScopes") or scopes,
            delegated_by=from_persona.display_name,
            delegation_expires_at=vc.get("validUntil"),
            delegation_revoked_at=None,
        )
        print(f'[Agent] Delegated {", ".join(scopes)} from {from_persona.display_name} to {to_persona.display_name} ({lifetime}s).', flush=True)
        return jsonify({
            "success": True,
            "persona": updated.to_public(),
            "delegatedVcId": vc["id"],
            "validUntil": vc.get("validUntil"),
            "detail": f"{from_persona.display_name} delegated [{', '.join(scopes)}] to {to_persona.display_name}, valid until {vc.get('validUntil') or 'unknown'}.",
        })
    except Exception as error:  # noqa: BLE001
        return _fail(error, "delegation failed")


# Kept for the curl test plan in README.md: a fixed Planner/Research pair.
@app.post("/delegation-demo-agents")
def delegation_demo_agents():
    try:
        if not has_persona(DELEGATION_PLANNER_ID):
            add_persona(enroll_persona(EnrollInput(id=DELEGATION_PLANNER_ID, display_name="Planner Agent", scopes=DELEGATION_SCOPES, max_delegation_depth=1)).persona)
        if not has_persona(DELEGATION_RESEARCH_ID):
            add_persona(enroll_persona(EnrollInput(id=DELEGATION_RESEARCH_ID, display_name="Research Agent", scopes=[])).persona)
        return jsonify({"plannerPersonaId": DELEGATION_PLANNER_ID, "researchPersonaId": DELEGATION_RESEARCH_ID})
    except Exception as error:  # noqa: BLE001
        return _fail(error, "delegation setup failed")


# ── Traveler consent at a service ──────────────────────────────────────────
# The traveler approved on the consent screen; the service (the MCP server
# process, playing the SP) asks the platform to sign the grant with its own
# key. This route only relays the traveler's choice and indexes the result.
@app.post("/consent")
def consent():
    body = request.get_json(silent=True) or {}
    persona, failure = _require_persona(body.get("personaId"))
    if failure:
        return failure
    user_id, service_id, scopes, durability = body.get("userId"), body.get("serviceId"), body.get("scopes"), body.get("durability")
    if user_id not in USERS:
        return jsonify({"error": f"userId must be one of {', '.join(USERS)}"}), 400
    if service_id not in SERVICES:
        return jsonify({"error": f"serviceId must be one of {', '.join(SERVICES)}"}), 400
    if not isinstance(scopes, list) or not scopes:
        return jsonify({"error": "scopes is required"}), 400
    service_name = SERVICES[service_id].short_name
    try:
        sp_res = requests.post(
            f"{env.mcp_base_url}/sp/{service_id}/consent",
            json={"agentDid": persona.did, "userDid": USERS[user_id]["did"], "scopes": scopes, "durability": durability},
            timeout=20,
        )
        sp_body = sp_res.json() if sp_res.content else {}
        grant = sp_body.get("grant")
        if not sp_res.ok or not grant:
            code = sp_body.get("code") or "CONSENT_FAILED"
            return jsonify({"success": False, "code": code, "detail": f"{service_name} could not issue the consent [{code}]: {sp_body.get('error') or f'HTTP {sp_res.status_code}'}"}), (sp_res.status_code if sp_res.status_code >= 400 else 502)
        record = {**grant, "personaId": persona.id, "userId": user_id, "serviceId": service_id}
        add_grant(record)
        return jsonify({
            "success": True,
            "grant": record,
            "detail": f"{USERS[user_id]['name']} let {persona.display_name} use [{', '.join(grant['scopes'])}] at {service_name} ({grant['durability']}, valid until {grant.get('validUntil')}).",
        }), 201
    except Exception as error:  # noqa: BLE001
        return _fail(error, "consent failed")


@app.get("/grants")
def get_grants():
    return jsonify({"grants": list_grants(request.args.get("personaId") or None)})


# The traveler withdraws their consent. Unlike /revoke-agent, the agent's
# own credential is untouched: it can still act on its own authority, and
# for every other traveler who consented.
@app.post("/revoke-grant")
def revoke_grant():
    grant_id = (request.get_json(silent=True) or {}).get("grantId")
    if not grant_id:
        return jsonify({"error": "grantId is required"}), 400
    try:
        result = admin_call(f"/v1/vcs/{quote(grant_id, safe='')}/revoke")
        if not result["ok"]:
            return _refused(result)
        grant = mark_grant_revoked(grant_id, result["body"].get("revokedAt") or _now())
        return jsonify({"success": True, "grant": grant, "detail": f"Consent {grant_id} revoked."})
    except Exception as error:  # noqa: BLE001
        return _fail(error, "revoke-grant failed")


# ── Attack scenarios ───────────────────────────────────────────────────────
def _attack(handler, fallback: str):
    body = request.get_json(silent=True) or {}
    persona = None
    if "personaId" in body:
        persona, failure = _require_persona(body.get("personaId"))
        if failure:
            return failure
    try:
        result = handler(body, persona)
        if isinstance(result, tuple):
            return result
        return jsonify(result), (200 if result.get("success") else 403)
    except Exception as error:  # noqa: BLE001
        return _fail(error, fallback)


@app.post("/attack/capture")
def attack_capture():
    return _attack(lambda body, persona: capture_and_send(persona, str(body.get("toolName") or ""), body.get("input") or {}), "capture failed")


@app.post("/attack/replay")
def attack_replay():
    return _attack(lambda body, _persona: replay(str(body.get("captureId") or "")), "replay failed")


@app.post("/attack/tamper")
def attack_tamper():
    def run(body, persona):
        add_scopes = body.get("addScopes") if isinstance(body.get("addScopes"), list) else ["write:orders"]
        return tamper_and_send(persona, str(body.get("toolName") or ""), body.get("input") or {}, add_scopes)

    return _attack(run, "tamper failed")


@app.post("/attack/wrong-service")
def attack_wrong_service():
    def run(body, persona):
        sign_for = body.get("signFor")
        if sign_for not in SERVICES:
            return jsonify({"error": "signFor must be air or stay"}), 400
        return present_to_wrong_service(persona, sign_for, str(body.get("toolName") or ""), body.get("input") or {})

    return _attack(run, "wrong-service failed")


def create_app() -> Flask:
    load_personas()
    return app


if __name__ == "__main__":
    create_app()
    print(f"[Agent] Travel concierge listening on :{env.agent_port} (LLM_PROVIDER={env.llm_provider}, personas: {len(list_personas())}).", flush=True)
    app.run(host="0.0.0.0", port=env.agent_port, threaded=True)
