# mcp_server -- a Model Context Protocol server exposing two protected tools:
# search_flights (needs read:catalog) and book_flight (needs write:orders).
# Python port of ../../e2e-travel-concierge/mcp-server/server.ts.
#
# The only thing standing between an inbound tool call and the action is the
# service's KYA-OS check (stories C-C, F-2), done here, in-process, with
# helix_mcp_middleware's local verifier:
#   1. the agent's request proof: signed by the key its DID document lists, for
#      this service (audience), fresh, each nonce once;
#   2. its Entity Card: the capabilities its credentials attest, and its
#      revocation entry, read live from HelixID's status list;
#   3. the delegation chain it carries: every hop's signature and status
#      (live), rooted in the agent's responsible party, narrowing at each link;
#   4. the tool's scope among the effective scopes (attestations ∩ chain ∩ this
#      service's catalog).
# No proof, a bad one, a revoked agent or hop, or the wrong scope, and the tool
# never runs. Every answer carries this service's response proof, signed with
# its own key. MCP over JSON-RPC: initialize, tools/list and tools/call (the
# helix_mcp_middleware verifier is synchronous, so plain Flask serves it).

from __future__ import annotations

import json
import time
import uuid
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

import requests
from flask import Flask, jsonify, request

from config import SCOPES, TOOLS, env
from helix_mcp_middleware import attach_response_proof, build_response_proof, create_local_verifier
from helix_sdk.crypto.jws import EnvSigner
from helix_sdk.handshake import generate_nonce
from helix_sdk.response_proof import RESPONSE_PROOF_ENVELOPE_PROFILE, hash_request, hash_response
from helixid import helix_fetch_json
from service.identity import load_service

RunFn = Callable[[Dict[str, Any], str], Tuple[str, Dict[str, Any]]]


def log(message: str) -> None:
    print(f"[MCP] {message}", flush=True)


def _deny(tool: str, code: str, reason: str) -> Dict[str, Any]:
    log(f"DENIED  {tool}  {code}  {reason}")
    return {
        "isError": True,
        "content": [{"type": "text", "text": f"Refused by HelixID [{code}]: {reason}."}],
        "structuredContent": {"refused": True, "code": code, "reason": reason},
    }


def _run_search_flights(args: Dict[str, Any], agent_did: str) -> Tuple[str, Dict[str, Any]]:
    origin = str(args.get("origin") or "")
    destination = str(args.get("destination") or "")
    flights = [
        {"flightId": "BA249", "carrier": "British Airways", "origin": origin, "destination": destination, "departs": "18:40"},
        {"flightId": "AI302", "carrier": "Air India", "origin": origin, "destination": destination, "departs": "09:15"},
    ]
    structured = {"flights": flights, "searchedBy": agent_did}
    return json.dumps(structured), structured


def _run_book_flight(args: Dict[str, Any], agent_did: str) -> Tuple[str, Dict[str, Any]]:
    booking = {
        "bookingId": f"BKG-{uuid.uuid4().hex[:8].upper()}",
        "flightId": str(args.get("flightId") or ""),
        "passengerName": str(args.get("passengerName") or ""),
        "status": "CONFIRMED",
        "verifiedAgent": agent_did,
    }
    return json.dumps(booking), booking


TOOL_DEFS: List[Dict[str, Any]] = [
    {
        "name": TOOLS["SEARCH"],
        "title": "Search flights",
        "description": "Search available flights. Requires read:catalog.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "origin": {"type": "string", "description": "Origin city or airport code"},
                "destination": {"type": "string", "description": "Destination city or airport code"},
                "date": {"type": "string", "description": "Optional travel date, YYYY-MM-DD"},
            },
            "required": ["origin", "destination"],
        },
    },
    {
        "name": TOOLS["BOOK"],
        "title": "Book a flight",
        "description": "Book a specific flight for a passenger. Requires write:orders.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "flightId": {"type": "string", "description": "The flight identifier to book, e.g. BA249"},
                "passengerName": {"type": "string", "description": "Full name of the passenger"},
            },
            "required": ["flightId", "passengerName"],
        },
    },
]

_RUNNERS: Dict[str, RunFn] = {TOOLS["SEARCH"]: _run_search_flights, TOOLS["BOOK"]: _run_book_flight}
_REQUIRED_SCOPES: Dict[str, str] = {TOOLS["SEARCH"]: SCOPES["FLIGHTS_READ"], TOOLS["BOOK"]: SCOPES["FLIGHTS_BOOK"]}


def _helix_status_list_binding() -> Optional[Dict[str, List[str]]]:
    """HelixID's own status list, bound so a card's revocation entry is read (SPEC-ENTITY-CARD §10.3)."""
    try:
        issuer = requests.get(f"{env.helix_api_url}/health", timeout=10).json().get("issuerDid")
    except Exception:  # noqa: BLE001
        return None
    return {issuer: [f"{env.helix_api_url}/v1/status-list/helix-status-list-1"]} if issuer else None


service = load_service()
signer = EnvSigner(service.did, kid="key-1", env_var="SERVICE_KEY", env={"SERVICE_KEY": service.signing_key})
_settings: Dict[str, Any] = {
    "service_did": service.did,
    "catalog": [SCOPES["FLIGHTS_READ"], SCOPES["FLIGHTS_BOOK"]],
    "fetch": helix_fetch_json,
    "allow_loopback_http": True,
    "log": lambda _message: None,
}
_binding = _helix_status_list_binding()
if _binding is not None:
    _settings["status_list_issuers"] = _binding
verifier = create_local_verifier(**_settings)


def _sign(request_: Mapping[str, Any], result: Dict[str, Any], outcome: str, client_did: Optional[str] = None) -> Dict[str, Any]:
    meta: Dict[str, Any] = {
        "did": service.did,
        "kid": f"{service.did}#key-1",
        "ts": int(time.time()),
        "nonce": generate_nonce(),
        "audience": service.did,
        "sessionId": "none",
        "requestHash": hash_request(request_),
        "outcome": outcome,
    }
    if outcome != "denied":
        meta["responseHash"] = hash_response(result, RESPONSE_PROOF_ENVELOPE_PROFILE)
        meta["prf"] = RESPONSE_PROOF_ENVELOPE_PROFILE
    if client_did is not None:
        meta["clientDid"] = client_did
    return attach_response_proof(result, build_response_proof(meta, signer))


def handle_tool_call(request_: Dict[str, Any]) -> Dict[str, Any]:
    params = request_.get("params") or {}
    name = str(params.get("name") or "")
    runner = _RUNNERS.get(name)
    required_scope = _REQUIRED_SCOPES.get(name)
    if runner is None or required_scope is None:
        return _sign(request_, _deny(name, "UNKNOWN_TOOL", f"no tool {name}"), "denied")
    args = params.get("arguments") or {}
    verdict = verifier.verify_call({"name": name, "input": args, "_meta": params.get("_meta"), "request": request_, "live_status": True})
    if verdict is None:
        return _sign(request_, _deny(name, "PROOF_MISSING", "no request proof was supplied"), "denied")
    if not verdict.ok or verdict.agent_did is None:
        code = (verdict.reasons or ["refused"])[0].upper()
        return _sign(request_, _deny(name, code, "; ".join(verdict.messages) or "the call did not verify"), "denied")
    scopes = list(verdict.effective_scopes)
    if required_scope not in scopes:
        reason = f"agent {verdict.agent_did} is verified but lacks {required_scope}; its effective scopes are [{', '.join(scopes) or 'none'}]"
        return _sign(request_, _deny(name, "INSUFFICIENT_SCOPE", reason), "denied", verdict.agent_did)
    log(f"GRANTED {name}  agent={verdict.agent_did}  scopes=[{', '.join(scopes)}]  level={verdict.level}")
    text, structured = runner(args, verdict.agent_did)
    return _sign(request_, {"content": [{"type": "text", "text": text}], "structuredContent": structured}, "allowed", verdict.agent_did)


app = Flask(__name__)


@app.get("/health")
def health():
    return jsonify({"status": "ok", "did": service.did, "tools": [TOOLS["SEARCH"], TOOLS["BOOK"]]})


@app.post("/mcp")
def mcp():
    rpc = request.get_json(silent=True) or {}
    rpc_id = rpc.get("id")
    method = rpc.get("method")
    if method == "tools/call":
        try:
            result = handle_tool_call({"method": "tools/call", "params": rpc.get("params") or {}})
        except Exception as error:  # noqa: BLE001
            log(f"check error: {error}")
            return jsonify({"jsonrpc": "2.0", "id": rpc_id, "error": {"code": -32603, "message": "Internal error"}}), 500
        return jsonify({"jsonrpc": "2.0", "id": rpc_id, "result": result})
    if method == "tools/list":
        return jsonify({"jsonrpc": "2.0", "id": rpc_id, "result": {"tools": TOOL_DEFS}})
    if method == "initialize":
        return jsonify(
            {
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "travel-booking-mcp", "version": "0.3.0"}},
            }
        )
    if rpc_id is None:  # a notification (notifications/initialized)
        return "", 202
    return jsonify({"jsonrpc": "2.0", "id": rpc_id, "error": {"code": -32601, "message": f"Method not found: {method}"}})


if __name__ == "__main__":
    log(f"travel-booking MCP server listening on :{env.mcp_port}/mcp")
    log(f"Service {service.did}: guarding {TOOLS['SEARCH']} (needs {SCOPES['FLIGHTS_READ']}) and {TOOLS['BOOK']} (needs {SCOPES['FLIGHTS_BOOK']}) with the KYA-OS local verifier.")
    app.run(host="0.0.0.0", port=env.mcp_port, threaded=True)
