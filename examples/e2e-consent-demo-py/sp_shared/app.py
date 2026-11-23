# One Service Provider app. Python port of sp-shared/app.ts. Both demo SPs
# are this same shape: only the tool catalog and scope strings differ.
#
#   POST /api/mcp   MCP endpoint (tools/list + tools/call). Open tools run for
#                   anyone; a scoped tool needs the user's consent, verified
#                   from the call itself (see kyaos_gate.py).
#
# KYA-OS story L3-H: consent is not a grant this SP signs. A call without the
# user's authority gets the signed needs_authorization challenge; its
# authorizationUrl is Helix's consent page, branded as this SP, where the
# user's own did:key signs the root of the agent's chain. The agent retries
# with that hop; this SP verifies it like any other chain. The SP renders no
# consent page and holds no key able to sign as a user.

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from flask import Flask, jsonify, request

from helix_mcp_middleware import ChallengeContext

from helixid_config import SpDefinition
from sp_shared.audit import AuditEmitter
from sp_shared.kyaos_gate import Gate, challenge_tool_result

# Which of this SP's users the agent acts for: the demo agent names the traveler's account here (see README).
SERVICE_USER_META_KEY = "org.helixid/service-user"


def _without_control_arguments(args: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in args.items() if not k.startswith("_kyaos") and k != "_helixCorrelationId"}


def create_sp_app(definition: SpDefinition, issuer_did: str, gate: Gate, audit: Optional[AuditEmitter] = None) -> tuple:
    # Test-visible counters: challenges answered, and scoped tools run on the user's consent.
    counters = {"consentRequired": 0, "authorized": 0}
    app = Flask(definition.id)

    def log(message: str) -> None:
        print(f"[{datetime.now(timezone.utc).isoformat()}] [{definition.id}] {message}", flush=True)

    def emit(**event: Any) -> None:
        if audit is not None:
            audit.emit(event)

    # The agent reads `did` from here at startup: Helix minted it at enrollment.
    @app.get("/health")
    def health() -> Any:
        return jsonify({"status": "ok", "sp": definition.id, "did": issuer_did, "tools": [tool.name for tool in definition.tools]})

    @app.post("/api/mcp")
    def mcp() -> Any:
        rpc = request.get_json(silent=True) or {}
        rpc_id = rpc.get("id")
        if rpc.get("method") == "tools/list":
            return jsonify(_jsonrpc_result(rpc_id, {"tools": [tool.to_dict() for tool in definition.tools]}))
        if rpc.get("method") != "tools/call":
            return jsonify(_jsonrpc_error(rpc_id, -32601, f"Method not found: {rpc.get('method')}"))

        params = rpc.get("params") or {}
        tool_name = params.get("name") or ""
        args = params.get("arguments") or {}
        meta = params.get("_meta") if isinstance(params.get("_meta"), dict) else {}
        tool = next((t for t in definition.tools if t.name == tool_name), None)
        if tool is None:
            return jsonify(_jsonrpc_error(rpc_id, -32602, f"Unknown tool: {tool_name}"))
        required_scope = tool.required_scope
        correlation_id = args.get("_helixCorrelationId") if isinstance(args.get("_helixCorrelationId"), str) else None
        call_request = {"method": "tools/call", "params": params}

        # Open, read-only tools run with no proof and no scope check.
        if not required_scope:
            log(f"OPEN    {tool_name}")
            output = _run_tool(tool_name, _without_control_arguments(args), "anonymous")
            emit(event="tool.call.completed", correlationId=correlation_id, toolName=tool_name, result="success",
                 resultSummary=_summarize_tool_result(tool_name, output), reason="OPEN_TOOL_NO_SCOPE_REQUIRED")
            return jsonify(_jsonrpc_result(rpc_id, {"structuredContent": output}))

        # The agent's own request proof, and the chain the user signed when there is one: verified here, from the call alone.
        verdict = gate.verify(call_request)
        if not verdict.ok:
            log(f"DENIED  {tool_name}  {verdict.code}")
            emit(event="proof.rejected", correlationId=correlation_id, toolName=tool_name, requiredScope=required_scope,
                 result="failure", reason=verdict.code, resultSummary=f"Verification failed ({verdict.code})")
            refused = {"isError": True, "content": [{"type": "text", "text": verdict.message}], "structuredContent": {"error": verdict.code}}
            return jsonify(_jsonrpc_result(rpc_id, gate.sign(call_request, refused, "denied")))

        scopes: List[str] = list(verdict.scopes or [])
        # L3-E: a retry after consent carries the resume token and the new hop; the hop is verified in full before it grants anything.
        retry = gate.needs_authorization.read_retry({"input": args})
        if retry is not None:
            try:
                granted = gate.needs_authorization.authorize_retry(
                    retry.resume_token, retry.credential, ChallengeContext(agent_did=verdict.agent_did, tool=tool_name, scopes=[required_scope])
                )
                scopes = list(dict.fromkeys(scopes + granted.scopes))
            except Exception as error:  # noqa: BLE001
                reason = getattr(error, "reason", None) or "resume_refused"
                log(f"DENIED  {tool_name}  retry refused ({reason})")
                refused = {"isError": True, "content": [{"type": "text", "text": str(error)}], "structuredContent": {"error": reason}}
                return jsonify(_jsonrpc_result(rpc_id, gate.sign(call_request, refused, "denied", verdict.agent_did)))

        if required_scope not in scopes:
            counters["consentRequired"] += 1
            service_user_id = meta.get(SERVICE_USER_META_KEY) if isinstance(meta.get(SERVICE_USER_META_KEY), str) else None
            if service_user_id is None:
                return jsonify(_jsonrpc_error(rpc_id, -32602, f"Consent for {required_scope} needs to know which of this service's users the agent acts for",
                                              {"code": "SERVICE_USER_REQUIRED"}))
            log(f"CONSENT {tool_name}  agent {verdict.agent_did} lacks {required_scope}; challenge for {service_user_id}")
            emit(event="authorization.denied", correlationId=correlation_id, agentDid=verdict.agent_did, toolName=tool_name,
                 requiredScope=required_scope, effectiveScopes=scopes, result="blocked", reason="NEEDS_AUTHORIZATION",
                 resultSummary=f"{tool_name} needs consent: the user has not yet authorized {definition.display_name}")
            try:
                # Creates the consent request at Helix (signed by this SP): its consent page is the challenge's URL.
                challenge = gate.challenge(verdict.agent_did, tool_name, required_scope, service_user_id)
            except Exception as error:  # noqa: BLE001 - e.g. Helix refused the consent request
                log(f"CONSENT {tool_name}  no consent request: {error}")
                return jsonify(_jsonrpc_error(rpc_id, -32603, f"Could not ask the user's consent: {error}", {"code": "CONSENT_REQUEST_FAILED"}))
            return jsonify(_jsonrpc_result(rpc_id, gate.sign(call_request, challenge_tool_result(challenge), "needs_authorization", verdict.agent_did)))

        counters["authorized"] += 1
        log(f"GRANTED {tool_name}  agent={verdict.agent_did}  user={verdict.user_did or '-'}  scopes=[{', '.join(scopes)}]  level={verdict.level}")
        emit(event="authorization.approved", correlationId=correlation_id, agentDid=verdict.agent_did, userDid=verdict.user_did,
             toolName=tool_name, requiredScope=required_scope, effectiveScopes=scopes, result="success",
             resultSummary=f'Authorized for "{required_scope}" on the user\'s consent')
        output = _run_tool(tool_name, _without_control_arguments(args), verdict.agent_did, verdict.user_did)
        emit(event="tool.call.completed", correlationId=correlation_id, agentDid=verdict.agent_did, toolName=tool_name,
             requiredScope=required_scope, effectiveScopes=scopes, result="success", resultSummary=_summarize_tool_result(tool_name, output))
        return jsonify(_jsonrpc_result(rpc_id, gate.sign(call_request, {"structuredContent": output}, "allowed", verdict.agent_did)))

    return app, counters


def _jsonrpc_result(rpc_id: Any, result: Any) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": rpc_id, "result": result}


def _jsonrpc_error(rpc_id: Any, code: int, message: str, data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    error: Dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": rpc_id, "error": error}


# -- C4: the booking backend --------------------------------------------------


def _summarize_tool_result(tool_name: str, output: Dict[str, Any]) -> str:
    flights = output.get("flights")
    if isinstance(flights, list):
        return f"{len(flights)} flight{'' if len(flights) == 1 else 's'} found"
    hotels = output.get("hotels")
    if isinstance(hotels, list):
        return f"{len(hotels)} hotel{'' if len(hotels) == 1 else 's'} found"
    booking_id = output.get("bookingId")
    if isinstance(booking_id, str) and booking_id:
        status = output.get("status") if isinstance(output.get("status"), str) else "OK"
        return f"{status} — {booking_id}"
    return f"{tool_name} completed"


def _run_tool(tool_name: str, args: Dict[str, Any], agent_did: str, user_did: Optional[str] = None) -> Dict[str, Any]:
    # user_did: the user's did:key that signed the root hop -- whom the booking is for.
    on_behalf_of = {} if user_did is None else {"onBehalfOf": user_did}
    if tool_name == "search_flights":
        origin = str(args.get("origin", "")).upper()
        destination = str(args.get("destination", "")).upper()
        departure_date = str(args.get("departureDate", ""))
        travelers = max(1, _to_int(args.get("travelers"), 1))
        carrier_pref = str(args.get("carrier", "")).strip().lower()

        route = f"{origin}-{destination}"
        inventory = FLIGHT_INVENTORY.get(route, [])
        date_available = departure_date == "" or _is_searchable_date(departure_date)

        flights = inventory if date_available else []
        if carrier_pref and carrier_pref != "any":
            narrowed = [f for f in flights if carrier_pref in f["carrier"].lower()]
            if narrowed:
                flights = narrowed

        return {
            "query": {
                "origin": origin,
                "destination": destination,
                "departureDate": departure_date,
                "travelers": travelers,
                "carrier": carrier_pref or "any",
            },
            "flights": [
                {
                    **f,
                    "origin": origin,
                    "destination": destination,
                    "departureDate": departure_date,
                    "travelers": travelers,
                    "totalFare": f["fare"] * travelers,
                }
                for f in flights
            ],
        }
    if tool_name == "book_flight":
        return {
            "bookingId": f"FLT-{uuid.uuid4().hex[:8].upper()}",
            "flightId": str(args.get("flightId", "")),
            "status": "CONFIRMED",
            "bookedBy": agent_did,
            **on_behalf_of,
        }
    if tool_name == "modify_booking":
        return {
            "bookingId": str(args.get("bookingId", "")),
            "status": "MODIFIED",
            "modifiedBy": agent_did,
            **on_behalf_of,
        }
    if tool_name == "search_hotels":
        city = str(args.get("city", "DEL")).upper()
        max_nightly_rate = _to_int(args.get("maxNightlyRate"), 0)
        guests = max(1, _to_int(args.get("guests"), 1))

        hotels = HOTEL_INVENTORY.get(city, [])
        if max_nightly_rate > 0:
            affordable = [h for h in hotels if h["nightlyRate"] <= max_nightly_rate]
            hotels = affordable if affordable else sorted(hotels, key=lambda h: h["nightlyRate"])[:1]

        return {
            "query": {"city": city, "maxNightlyRate": max_nightly_rate or None, "guests": guests},
            "hotels": [{**h, "city": city, "guests": guests} for h in hotels],
        }
    if tool_name == "book_hotel":
        return {
            "bookingId": f"HTL-{uuid.uuid4().hex[:8].upper()}",
            "hotelId": str(args.get("hotelId", "")),
            "status": "CONFIRMED",
            "bookedBy": agent_did,
            **on_behalf_of,
        }
    return {"ok": True}


def _to_int(value: Any, default: int) -> int:
    try:
        return int(value) if value not in (None, "") else default
    except (TypeError, ValueError):
        return default


FLIGHT_INVENTORY: Dict[str, List[Dict[str, Any]]] = {
    "TVM-DEL": [
        {"flightId": "HA401", "carrier": "Helix Air", "departs": "08:20", "arrives": "11:05", "durationMinutes": 165, "stops": 0, "fare": 8450, "cabin": "Economy"},
        {"flightId": "HA733", "carrier": "Helix Air", "departs": "19:05", "arrives": "21:50", "durationMinutes": 165, "stops": 0, "fare": 6980, "cabin": "Economy"},
        {"flightId": "SK512", "carrier": "Skyline", "departs": "13:40", "arrives": "17:20", "durationMinutes": 220, "stops": 1, "fare": 5600, "cabin": "Economy"},
    ],
    "TVM-BOM": [
        {"flightId": "HA215", "carrier": "Helix Air", "departs": "07:10", "arrives": "09:15", "durationMinutes": 125, "stops": 0, "fare": 6300, "cabin": "Economy"},
        {"flightId": "SK629", "carrier": "Skyline", "departs": "16:45", "arrives": "19:10", "durationMinutes": 145, "stops": 0, "fare": 4850, "cabin": "Economy"},
    ],
    "DEL-TVM": [
        {"flightId": "HA402", "carrier": "Helix Air", "departs": "14:30", "arrives": "17:20", "durationMinutes": 170, "stops": 0, "fare": 8100, "cabin": "Economy"},
        {"flightId": "SK513", "carrier": "Skyline", "departs": "06:15", "arrives": "10:05", "durationMinutes": 230, "stops": 1, "fare": 5400, "cabin": "Economy"},
    ],
    "BOM-TVM": [
        {"flightId": "HA216", "carrier": "Helix Air", "departs": "18:15", "arrives": "20:20", "durationMinutes": 125, "stops": 0, "fare": 6150, "cabin": "Economy"},
    ],
}

HOTEL_INVENTORY: Dict[str, List[Dict[str, Any]]] = {
    "DEL": [
        {"hotelId": "HS-DEL-1", "name": "Helix Stay Aerocity", "nightlyRate": 7400, "rating": 4.5, "area": "Aerocity", "amenities": ["Airport shuttle", "Pool", "Breakfast"]},
        {"hotelId": "HS-DEL-2", "name": "Helix Stay Connaught", "nightlyRate": 9100, "rating": 4.7, "area": "Connaught Place", "amenities": ["City centre", "Spa", "Breakfast"]},
        {"hotelId": "HS-DEL-3", "name": "Helix Stay Saket", "nightlyRate": 4900, "rating": 4.1, "area": "Saket", "amenities": ["Metro nearby", "Workspace"]},
    ],
    "BOM": [
        {"hotelId": "HS-BOM-1", "name": "Helix Stay Bandra", "nightlyRate": 8200, "rating": 4.6, "area": "Bandra West", "amenities": ["Sea view", "Gym"]},
        {"hotelId": "HS-BOM-2", "name": "Helix Stay Andheri", "nightlyRate": 5300, "rating": 4.2, "area": "Andheri East", "amenities": ["Airport shuttle", "Workspace"]},
    ],
}


def _is_searchable_date(value: str) -> bool:
    import re

    if not re.match(r"^\d{4}-\d{2}-\d{2}$", value):
        return False
    try:
        requested = datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return False
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    from datetime import timedelta

    return today <= requested <= today + timedelta(days=365)
