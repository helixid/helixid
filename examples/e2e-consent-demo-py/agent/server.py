# Travel Planner Agent. Python port of agent/server.ts.
#
# The agent calls SP tools. It has no consent logic of
# its own: when an SP answers "not without a grant", the agent hands the
# user off to that SP's consent page and waits for the grant to come back.
#
# How the grant becomes usable in the browser flow:
#   1. POST /api/call     -> { status: 'consent_required', consentUrl }
#   2. the UI opens consentUrl (the SP's own page, on the SP's own origin)
#   3. the page posts the signed grant back via postMessage
#   4. the UI forwards it to POST /api/grants, which acknowledges it -- the
#      platform already holds it, so there is nothing agent-side to store
#   5. the UI retries POST /api/call, which now finds the grant and succeeds
#
# Tool planning is provider-neutral: Gemini, OpenAI, or Anthropic when a key
# is configured, with a deterministic scripted fallback when it is not.

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from flask import Flask, Response, jsonify, request

from helix_sdk.client import HelixClient

from agent.consent_aware_call import ConsentDeclinedError, call_sp_tool
from agent.conversation import (
    city_label,
    extract_slots,
    mentions_booking_confirmation,
    mentions_flight,
    mentions_trip_planning,
    next_flight_question,
    next_hotel_question,
    next_return_question,
    resolve_track,
    summarise_profile,
)
from agent.planner import (
    DeterministicPlanner,
    ToolValidationError,
    create_tool_planner,
    describe_plan_for_history,
    phrase_question,
)
from agent.web import agent_page_html
from helixid_config import AIRLINE, DEMO_USER_DID, HOTEL, agent_identity_path, env, sp_did_for

SP_BY_ID = {"airline": AIRLINE, "hotel": HOTEL}
AGENT_USERNAME = "traveler"
AGENT_PASSWORD = "demo123"

DEFAULT_MODELS = {"gemini": "gemini-2.5-flash", "openai": "gpt-4o-mini", "anthropic": "claude-sonnet-4-5"}


def log(message: str) -> None:
    print(f"[{datetime.now(timezone.utc).isoformat()}] [agent] {message}", flush=True)


def _known_facts(profile: Dict[str, Any]) -> Dict[str, Any]:
    known: Dict[str, Any] = {}
    if profile.get("origin"):
        known["flyingFrom"] = city_label(profile["origin"])
    if profile.get("destination"):
        known["flyingTo"] = city_label(profile["destination"])
    if profile.get("departureDate"):
        known["departureDate"] = profile["departureDate"]
    if profile.get("returnDate"):
        known["returnDate"] = profile["returnDate"]
    if profile.get("travelers"):
        known["travellers"] = profile["travelers"]
    if profile.get("airlinePreference"):
        known["airline"] = profile["airlinePreference"]
    if profile.get("hotelBudget"):
        known["nightlyBudget"] = profile["hotelBudget"]
    return known


def create_app() -> tuple:
    identity_file = agent_identity_path(env.wallets_dir, "travel-planner")
    try:
        with open(identity_file, "r", encoding="utf-8") as handle:
            identity = json.load(handle)
    except (OSError, ValueError) as exc:
        raise RuntimeError(
            f"No agent identity at {identity_file}. Run the seeder before starting the agent."
        ) from exc
    agent_did = identity["agentDid"]

    # The admin key is what lets this process ask the API to sign on the
    # agent's behalf. In OSS there is no per-agent credential narrower than it.
    client = HelixClient(env.helix_api_url, admin_api_key=env.admin_api_key)

    planner = (
        create_tool_planner(env.llm_provider, env.llm_api_key, env.llm_model or DEFAULT_MODELS[env.llm_provider])
        if env.llm_api_key
        else DeterministicPlanner()
    )
    fallback_planner = DeterministicPlanner()
    log(f"agent identity loaded: {agent_did}")

    app = Flask(__name__)
    sessions: Dict[str, Dict[str, str]] = {}
    conversation_history: Dict[str, List[Dict[str, str]]] = {}
    trip_profiles: Dict[str, Dict[str, Any]] = {}
    planner_info = {"provider": planner.provider, "model": planner.model}

    sp_origins = [f"http://{env.host}:{sp.port}" for sp in SP_BY_ID.values()]

    @app.get("/")
    def index() -> Any:
        return Response(agent_page_html(sp_origins), mimetype="text/html")

    @app.get("/api/session")
    def session_info() -> Any:
        token = request.cookies.get("agent_session", "")
        session = sessions.get(token)
        if session:
            return jsonify({"authenticated": True, **session, "agentDid": agent_did, "planner": planner_info})
        return jsonify({"authenticated": False, "planner": planner_info})

    @app.post("/api/login")
    def login() -> Any:
        body = request.get_json(silent=True) or {}
        if body.get("username") != AGENT_USERNAME or body.get("password") != AGENT_PASSWORD:
            return jsonify({"error": "Invalid username or password"}), 401
        token = str(uuid.uuid4())
        sessions[token] = {"username": AGENT_USERNAME, "userDid": DEMO_USER_DID}
        conversation_history[token] = []
        resp = jsonify(
            {
                "authenticated": True,
                "username": AGENT_USERNAME,
                "userDid": DEMO_USER_DID,
                "agentDid": agent_did,
                "planner": planner_info,
            }
        )
        resp.set_cookie("agent_session", token, httponly=True, samesite="Lax", path="/")
        return resp

    @app.post("/api/logout")
    def logout() -> Any:
        token = request.cookies.get("agent_session", "")
        sessions.pop(token, None)
        conversation_history.pop(token, None)
        resp = Response(status=204)
        resp.set_cookie("agent_session", "", httponly=True, samesite="Lax", path="/", max_age=0)
        return resp

    @app.before_request
    def require_session() -> Any:
        if not request.path.startswith("/api"):
            return None
        # /api/login, /api/session, and /api/logout all have to work without
        # an existing session (matching server.ts: those three routes are
        # registered before the auth middleware, so Express never runs it
        # for them at all).
        if request.path in ("/api/login", "/api/session", "/api/logout"):
            return None
        token = request.cookies.get("agent_session", "")
        if token not in sessions:
            return jsonify({"error": "Please log in to the demo agent"}), 401
        request.environ["agent_session_token"] = token
        return None

    @app.get("/health")
    def health() -> Any:
        return jsonify({"status": "ok", "agentDid": agent_did, "userDid": DEMO_USER_DID, "llm": planner_info})

    def _record_turn(token: str, history: List[Dict[str, str]], user_message: str, plan: Dict[str, Any]) -> None:
        conversation_history[token] = (
            history
            + [{"role": "user", "content": user_message}, {"role": "assistant", "content": describe_plan_for_history(plan)}]
        )[-12:]

    @app.post("/api/plan")
    def plan_route() -> Any:
        body = request.get_json(silent=True) or {}
        message = body.get("message")
        if not isinstance(message, str) or not message.strip():
            return jsonify({"error": "message is required"}), 400

        token = request.environ.get("agent_session_token", "")
        history = conversation_history.get(token, [])
        user_message = message.strip()
        context = body.get("context") or {}

        answering_slot = body.get("answering") is True
        track = resolve_track(user_message, answering_slot, body.get("track"))
        returning = track == "return"

        profile = extract_slots(user_message, trip_profiles.get(token, {}), for_return=returning)
        trip_profiles[token] = profile

        wants_hotel = track == "hotel"
        wants_flight = mentions_flight(user_message) or mentions_trip_planning(user_message) or returning
        confirming_option = mentions_booking_confirmation(user_message)
        search_intent = not confirming_option and (wants_hotel or wants_flight or answering_slot)

        if search_intent:
            question = (
                next_hotel_question(profile)
                if track == "hotel"
                else next_return_question(profile)
                if track == "return"
                else next_flight_question(profile)
            )

            if question:
                spoken = phrase_question(planner, question["question"], question["suggestions"], _known_facts(profile))
                log(
                    f"asking {question['field']} in the engine's own words"
                    if spoken == question["question"]
                    else f"asking {question['field']}, reworded by {planner.provider}"
                )
                ask = {"kind": "ask", "field": question["field"], "message": spoken, "suggestions": question["suggestions"]}
                _record_turn(token, history, user_message, ask)
                return jsonify({**ask, "planner": planner_info, "profile": profile, "summary": summarise_profile(profile), "track": track})

            if track == "hotel":
                tool_plan = {
                    "kind": "tool_call",
                    "tool": "search_hotels",
                    "args": {
                        "city": profile["destination"],
                        "maxNightlyRate": str(profile.get("hotelBudget", 0)),
                        "guests": str(profile.get("travelers", 1)),
                    },
                }
            elif track == "return":
                tool_plan = {
                    "kind": "tool_call",
                    "tool": "search_flights",
                    "args": {
                        "origin": profile["destination"],
                        "destination": profile["origin"],
                        "departureDate": profile["returnDate"],
                        "travelers": str(profile.get("travelers", 1)),
                        "carrier": profile.get("airlinePreference", "any"),
                    },
                }
            else:
                tool_plan = {
                    "kind": "tool_call",
                    "tool": "search_flights",
                    "args": {
                        "origin": profile["origin"],
                        "destination": profile["destination"],
                        "departureDate": profile["departureDate"],
                        "travelers": str(profile.get("travelers", 1)),
                        "carrier": profile.get("airlinePreference", "any"),
                    },
                }

            _record_turn(token, history, user_message, tool_plan)
            log(f"gathered details, searching {tool_plan['tool']}")
            return jsonify(
                {**tool_plan, "planner": planner_info, "profile": profile, "summary": summarise_profile(profile), "track": track}
            )

        used_planner = planner_info
        try:
            plan = planner.plan(user_message, context, history)
        except ToolValidationError as exc:
            log(f"rejected a planned tool call: {exc}")
            plan = {"kind": "message", "message": f"{exc}. Could you restate what you'd like?"}
        except Exception as exc:  # noqa: BLE001
            log(f"{planner.provider} unavailable, falling back to the scripted planner: {exc}")
            try:
                plan = fallback_planner.plan(user_message, context, history)
                used_planner = {"provider": fallback_planner.provider, "model": fallback_planner.model}
            except ToolValidationError as fallback_exc:
                plan = {"kind": "message", "message": f"{fallback_exc}. Could you restate what you'd like?"}
                used_planner = {"provider": fallback_planner.provider, "model": fallback_planner.model}
            except Exception:  # noqa: BLE001
                plan = {"kind": "message", "message": "I could not work out what to do next. Could you restate what you'd like?"}
                used_planner = {"provider": fallback_planner.provider, "model": fallback_planner.model}

        _record_turn(token, history, user_message, plan)
        log(f"{used_planner['provider']} planned {plan['tool'] if plan['kind'] == 'tool_call' else 'a text response'}")
        current_profile = trip_profiles.get(token, {})
        return jsonify(
            {**plan, "planner": used_planner, "profile": current_profile, "summary": summarise_profile(current_profile)}
        )

    def _held_grants_by_service() -> Dict[str, Dict[str, Any]]:
        """Every grant the platform holds for this agent and this user,
        keyed by the service it authorizes. One pass over the agent's active
        credentials rather than one lookup per SP."""
        by_service: Dict[str, Dict[str, Any]] = {}
        for summary in client.list_vcs(subject_did=agent_did, status="active"):
            vc = (client.get_vc(summary["vcId"]) or {}).get("vc")
            if not vc or "DelegationGrantCredential" not in (vc.get("type") or []):
                continue
            subject = vc.get("credentialSubject") or {}
            if subject.get("userDid") != DEMO_USER_DID:
                continue
            service_did = subject.get("serviceDid") or vc.get("issuer")
            if service_did:
                by_service[service_did] = subject
        return by_service

    @app.get("/api/state")
    def state() -> Any:
        held_grants = _held_grants_by_service()
        grants = []
        for sp in SP_BY_ID.values():
            service_did = sp_did_for(env.host, sp.port)
            held = held_grants.get(service_did)
            subject = held or {}
            grants.append(
                {
                    "sp": sp.id,
                    "displayName": sp.display_name,
                    "serviceDid": service_did,
                    "hasGrant": bool(held),
                    "scopes": subject.get("scopes", []),
                    "durability": subject.get("durability"),
                }
            )
        return jsonify({"agentDid": agent_did, "userDid": DEMO_USER_DID, "grants": grants})

    @app.post("/api/call")
    def call() -> Any:
        body = request.get_json(silent=True) or {}
        sp = SP_BY_ID.get(body.get("sp", "")) if body.get("sp") else None
        tool = body.get("tool")
        if not sp or not tool:
            return jsonify({"error": "sp and tool are required"}), 400

        service_did = sp_did_for(env.host, sp.port)
        base_url = env.airline_url if sp.id == "airline" else env.hotel_url
        public_base_url = f"http://{env.host}:{sp.port}"
        correlation_id = f"act_{uuid.uuid4().hex[:12]}"

        def on_consent_required(prompt: Dict[str, str]) -> Optional[Dict[str, Any]]:
            log(f"consent required for {tool} at {prompt['serviceDid']}")
            return None

        try:
            result = call_sp_tool(
                client=client,
                agent_did=agent_did,
                user_did=DEMO_USER_DID,
                sp_mcp_url=f"{base_url}/api/mcp",
                service_did=service_did,
                tool_name=tool,
                on_consent_required=on_consent_required,
                args=body.get("args"),
                correlation_id=correlation_id,
            )

            if result["ok"]:
                matched_tool = next((t for t in sp.tools if t.name == tool), None)
                protected_tool = bool(matched_tool and matched_tool.required_scope)
                authorization_source = (
                    ("fresh_consent" if body.get("authorizationSource") == "fresh_consent" else "standing_grant")
                    if protected_tool
                    else "not_required"
                )
                log(f"{tool} succeeded (authorizationSource={authorization_source})")
                return jsonify({"status": "ok", "data": result.get("data"), "authorizationSource": authorization_source})
            return jsonify({"status": "error", "error": result.get("error")})
        except ConsentDeclinedError:
            return jsonify(
                {
                    "status": "consent_required",
                    "sp": sp.id,
                    "serviceDid": service_did,
                    "consentUrl": (
                        f"{public_base_url}/consent?agentDid={_qs(agent_did)}"
                        f"&userDid={_qs(DEMO_USER_DID)}&correlationId={_qs(correlation_id)}"
                    ),
                    "correlationId": correlation_id,
                }
            )
        except Exception as exc:  # noqa: BLE001
            return jsonify({"status": "error", "error": {"message": str(exc)}}), 500

    @app.post("/api/grants")
    def grants() -> Any:
        body = request.get_json(silent=True) or {}
        grant_vc = body.get("grantVC")
        if not grant_vc:
            return jsonify({"error": "grantVC is required"}), 400
        # Nothing to store: the platform recorded this grant when the SP
        # finalized it, and /api/call reads it back from there. The route
        # stays because the browser flow posts here.
        log(f"grant {grant_vc.get('id')} from {grant_vc.get('issuer')} acknowledged (held by platform)")
        return jsonify({"stored": True}), 201

    return app, agent_did


def _qs(value: str) -> str:
    from urllib.parse import quote

    return quote(value, safe="")


if __name__ == "__main__":
    flask_app, agent_did = create_app()
    log(f"Travel Planner Agent listening on :{env.agent_port}")
    log(f"agent DID {agent_did}")
    log(f"acting for {DEMO_USER_DID}")
    flask_app.run(host="0.0.0.0", port=env.agent_port)
