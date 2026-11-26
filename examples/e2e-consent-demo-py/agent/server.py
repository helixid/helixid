# Travel Planner Agent. Python port of examples/e2e-consent-demo/agent/server.ts.
#
# The agent keeps its own key (self custody: seed/seed.py ran helix init): it
# signs every request proof itself; Helix never holds its key. It has no consent
# logic of its own: when an SP answers with the signed needs_authorization
# challenge, the agent checks the SP's response proof and hands the user the
# consent URL, which is Helix's consent page (KYA-OS story L3-H). There the
# user's own did:key signs the root hop of the agent's chain.
#
# The browser flow:
#   1. POST /api/call             -> { status: 'consent_required', consentUrl, pendingId }
#   2. the UI opens consentUrl (Helix's page, on Helix's origin)
#   3. the UI calls POST /api/consent/complete { pendingId }: the agent waits
#      for the user's decision, keeps the signed root hop and retries the call
#      with the resume token and the hop
#
# Step 4 of the demo flow short-circuits all of that: /api/call carries the
# stored hop on the first attempt (renewed without a click when due).
#
# Tool planning is provider-neutral: Gemini, OpenAI, or Anthropic when a key
# is configured, with a deterministic scripted fallback when it is not.

from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List

import requests

from dotenv import load_dotenv

load_dotenv()

from flask import Flask, Response, jsonify, request  # noqa: E402

from helix_sdk import consent as helix_consent  # noqa: E402
from helix_sdk.crypto.jws import EnvSigner  # noqa: E402
from helix_sdk.errors import ConsentFlowError  # noqa: E402
from helix_sdk.verifier.resolve import create_did_resolver  # noqa: E402

from agent.consent_aware_call import CallSpToolOptions, call_sp_tool, complete_consent  # noqa: E402
from agent.consent_store import ConsentStore  # noqa: E402
from agent.conversation import (  # noqa: E402
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
from agent.planner import (  # noqa: E402
    DeterministicPlanner,
    ToolValidationError,
    create_tool_planner,
    describe_plan_for_history,
    phrase_question,
)
from agent.web import agent_page_html  # noqa: E402
from helixid_config import AIRLINE, DEMO_SERVICE_USER, HOTEL, agent_dir, allow_loopback_http, env  # noqa: E402

SP_BY_ID = {"airline": AIRLINE, "hotel": HOTEL}
AGENT_USERNAME = "traveler"
AGENT_PASSWORD = "demo123"
AGENT_ID = "travel-planner"

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


def _load_agent() -> tuple:
    """helix init's output: the agent's DID and kid (helix-agent.json) and its own key (signing-key.env)."""
    directory = agent_dir(env.wallets_dir)
    summary_file = os.path.join(directory, "helix-agent.json")
    key_file = os.path.join(directory, "signing-key.env")
    if not (os.path.exists(summary_file) and os.path.exists(key_file)):
        raise RuntimeError(f"No agent identity in {directory}. Run the seeder first: python -m seed.seed")
    with open(summary_file, "r", encoding="utf-8") as f:
        summary = json.load(f)
    key_env: Dict[str, str] = {}
    with open(key_file, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                name, value = line.split("=", 1)
                key_env[name.strip()] = value.strip()
    return summary["did"], summary["kid"], key_env


def _resolve_sp_dids() -> Dict[str, str]:
    """Each SP's Helix-hosted did:web, read from its /health -- the SPs must be up before the agent."""
    dids: Dict[str, str] = {}
    for sp_id, url in (("airline", env.airline_url), ("hotel", env.hotel_url)):
        try:
            did = requests.get(f"{url}/health", timeout=10).json().get("did")
        except Exception:  # noqa: BLE001
            did = None
        if not did:
            raise RuntimeError(f"SP at {url} is not up -- start sp_airline and sp_hotel first.")
        dids[sp_id] = did
    return dids


def _fetch_json(url: str) -> Any:
    response = requests.get(url, timeout=10)
    return response.json() if response.ok else None


def create_app() -> tuple:
    agent_did, kid, key_env = _load_agent()
    # Self custody: the agent signs its own request proofs; its key never leaves this process.
    signer = EnvSigner(agent_did, kid=kid, env_var="HELIX_SIGNING_KEY", env=key_env)
    consents = ConsentStore(os.path.join(env.wallets_dir, f"{AGENT_ID}-consents.json"))
    # The SPs' did:web documents are hosted by Helix; a local run serves them on loopback http.
    resolve_did = create_did_resolver(
        _fetch_json,
        rewrite_url=(lambda url: re.sub(r"^https://(localhost|127\.0\.0\.1)([:/])", r"http://\1\2", url)) if allow_loopback_http else None,
    )
    sp_dids = _resolve_sp_dids()
    # Challenged calls waiting for the user's decision on Helix's page.
    pending_calls: Dict[str, Dict[str, Any]] = {}

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


    @app.get("/")
    def index() -> Any:
        return Response(agent_page_html(), mimetype="text/html")

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
        sessions[token] = {"username": AGENT_USERNAME, "serviceUser": DEMO_SERVICE_USER}
        conversation_history[token] = []
        resp = jsonify(
            {
                "authenticated": True,
                "username": AGENT_USERNAME,
                "serviceUser": DEMO_SERVICE_USER,
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
        if request.path in ("/api/login", "/api/session", "/api/logout"):
            return None
        token = request.cookies.get("agent_session", "")
        if token not in sessions:
            return jsonify({"error": "Please log in to the demo agent"}), 401
        request.environ["agent_session_token"] = token
        return None

    @app.get("/health")
    def health() -> Any:
        return jsonify({"status": "ok", "agentDid": agent_did, "serviceUser": DEMO_SERVICE_USER, "llm": planner_info})

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

    @app.get("/api/state")
    def state() -> Any:
        """Everything the UI needs to render current authorization state: the root hop the user signed, per SP."""
        grants = []
        for sp in SP_BY_ID.values():
            service_did = sp_dids[sp.id]
            held = consents.get(service_did)
            hop = (held or {}).get("hop") or {}
            grants.append(
                {
                    "sp": sp.id,
                    "displayName": sp.display_name,
                    "serviceDid": service_did,
                    "hasGrant": bool(held),
                    # What the user consented to, not just that they consented.
                    "scopes": (hop.get("credentialSubject") or {}).get("allowedAction", []),
                    "windowUntil": datetime.fromtimestamp(held["windowUntil"], timezone.utc).isoformat().replace("+00:00", "Z") if held else None,
                    # The user's pairwise did:key at this SP: a different key per SP.
                    "userDid": hop.get("issuer") if held else None,
                }
            )
        return jsonify({"agentDid": agent_did, "serviceUser": DEMO_SERVICE_USER, "grants": grants})

    @app.post("/api/call")
    def call() -> Any:
        body = request.get_json(silent=True) or {}
        sp = SP_BY_ID.get(body.get("sp", "")) if body.get("sp") else None
        tool = body.get("tool")
        if not sp or not tool:
            return jsonify({"error": "sp and tool are required"}), 400

        service_did = sp_dids[sp.id]
        # The MCP URL may use a compose-internal hostname.
        base_url = env.airline_url if sp.id == "airline" else env.hotel_url
        # One id per user-initiated action, so the SP's verification / authorization /
        # invocation events all stitch back to it.
        correlation_id = f"act_{uuid.uuid4().hex[:12]}"
        options = CallSpToolOptions(
            signer=signer,
            agent_did=agent_did,
            consents=consents,
            service_user_id=DEMO_SERVICE_USER,
            sp_mcp_url=f"{base_url}/api/mcp",
            service_did=service_did,
            tool_name=tool,
            resolve_did=resolve_did,
            args=body.get("args") or {},
            correlation_id=correlation_id,
        )
        try:
            result = call_sp_tool(options)
            if result["status"] == "consent_required":
                # The agent does not resolve consent itself: it reports where the user
                # must go (the URL the SP signed), and the UI drives the handoff.
                prompt = result["prompt"]
                log(f"consent required for {tool} at {service_did}")
                pending_id = str(uuid.uuid4())
                pending_calls[pending_id] = {"options": options, "prompt": prompt}
                return jsonify(
                    {
                        "status": "consent_required",
                        "sp": sp.id,
                        "serviceDid": service_did,
                        "consentUrl": prompt.authorization_url,
                        "scopes": prompt.scopes,
                        "pendingId": pending_id,
                        "correlationId": correlation_id,
                    }
                )
            if result["status"] == "ok":
                matched_tool = next((t for t in sp.tools if t.name == tool), None)
                protected_tool = bool(matched_tool and matched_tool.required_scope)
                authorization_source = ("standing_grant" if result["consentReused"] else "fresh_consent") if protected_tool else "not_required"
                log(f"{tool} succeeded (authorizationSource={authorization_source})")
                return jsonify({"status": "ok", "data": result.get("data"), "authorizationSource": authorization_source})
            return jsonify({"status": "error", "error": result.get("error")})
        except Exception as exc:  # noqa: BLE001
            return jsonify({"status": "error", "error": {"message": str(exc)}}), 500

    @app.post("/api/consent/complete")
    def consent_complete() -> Any:
        """After the UI opened Helix's consent page: waits for the user's decision, keeps the root hop
        the user's did:key signed, and retries the challenged call with the resume token and that hop."""
        body = request.get_json(silent=True) or {}
        pending = pending_calls.pop(body.get("pendingId") or "", None)
        if pending is None:
            return jsonify({"status": "error", "error": {"message": "no call is waiting for consent"}}), 404
        options = pending["options"]
        try:
            result = complete_consent(options, pending["prompt"])
            if result["status"] == "ok":
                log(f"{options.tool_name} succeeded after consent (authorizationSource=fresh_consent)")
                return jsonify({"status": "ok", "data": result.get("data"), "authorizationSource": "fresh_consent"})
            return jsonify(result)
        except ConsentFlowError as exc:
            if exc.reason == helix_consent.ConsentReasons.NOT_APPROVED:
                log(f"consent declined for {options.tool_name} at {options.service_did}")
                return jsonify({"status": "declined"})
            return jsonify({"status": "error", "error": {"message": str(exc)}}), 500
        except Exception as exc:  # noqa: BLE001
            return jsonify({"status": "error", "error": {"message": str(exc)}}), 500

    return app, agent_did


if __name__ == "__main__":
    flask_app, resolved_agent_did = create_app()
    log(f"Travel Planner Agent listening on :{env.agent_port}")
    log(f"agent DID {resolved_agent_did}")
    log(f"acting for the SPs' user {DEMO_SERVICE_USER}")
    # threaded: /api/consent/complete waits on the user's decision while the page keeps working.
    flask_app.run(host="0.0.0.0", port=env.agent_port, threaded=True)
