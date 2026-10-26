# The single choke point where a verifiable presentation is created. Signs a
# fresh VP for the persona's agent DID via POST /v1/agents/:did/vp -- the
# server holds the key and signs server-side (agent self-custody is retired),
# so no private key is ever decrypted or transmitted here. That route is
# admin-gated in OSS, so this process holds the admin key.
#
# The VP is bound to the DID of the service that owns the tool, and -- when
# the agent acts for a traveler -- names that traveler. The platform then
# adds that traveler's consent grant for that service (or one a delegator up
# the chain holds); with none, it refuses to sign, which this module turns
# into a "consent required" result the UI can answer with a consent prompt.

from __future__ import annotations

from typing import Any, Dict, Optional
from urllib.parse import quote

from helix_sdk import HELIX_VP_META_KEY, encode_helix_vp

from agent.mcp_client import call_mcp_tool
from agent.services import get_service
from config import USERS, service_for_tool
from personas.platform import admin_call, describe_api_error
from personas.types import Persona


class SigningRefusedError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def sign_vp(persona: Persona, service_did: str, user_did: Optional[str] = None) -> Dict[str, Any]:
    body: Dict[str, Any] = {"targetService": service_did}
    if user_did:
        body["userDid"] = user_did
    # No vcId: the server presents every active credential the persona holds,
    # so a delegated one rides along automatically.
    result = admin_call(f"/v1/agents/{quote(persona.did, safe='')}/vp", body)
    signed_vp = result["body"].get("signedVP")
    if not result["ok"] or not signed_vp:
        error = result["body"].get("error") or {}
        raise SigningRefusedError(error.get("code") or f"HTTP_{result['status']}", describe_api_error(error, result["status"]))
    return signed_vp


def present_vp(service_id: str, tool_name: str, input: Dict[str, Any], vp: Dict[str, Any]) -> Dict[str, Any]:
    """Sends an already-signed VP with a tool call -- the VP travels in _meta, never in the tool arguments."""
    result = call_mcp_tool(tool_name, input, meta={HELIX_VP_META_KEY: encode_helix_vp(vp)})
    structured = result.structured or {}
    # Surface the real result (success or the real rejection reason) so the
    # model can report it truthfully -- the agent never writes the outcome itself.
    out: Dict[str, Any] = {"success": not result.is_error, "detail": result.text, "serviceId": service_id}
    if result.is_error:
        out["code"] = structured.get("code") or "REFUSED"
        out["stage"] = "service"
    else:
        out["data"] = result.structured
    return out


def _consent_prompt(service_id: str, user_id: str) -> Dict[str, Any]:
    service = get_service(service_id)
    return {
        "serviceId": service_id,
        "serviceName": service["name"],
        "userId": user_id,
        "userName": USERS[user_id]["name"],
        # Every scope the service's tools need -- the consent screen offers each one.
        "scopes": sorted({tool["requiredScope"] for tool in service["tools"]}),
    }


def call_protected_tool(persona: Persona, tool_name: str, input: Dict[str, Any], user_id: Optional[str] = None) -> Dict[str, Any]:
    definition = service_for_tool(tool_name)
    if definition is None:
        return {"success": False, "detail": f"Unknown tool: {tool_name}", "code": "UNKNOWN_TOOL"}
    service = get_service(definition.id)
    user = USERS[user_id] if user_id else None

    try:
        vp = sign_vp(persona, service["did"], user["did"] if user else None)
    except SigningRefusedError as error:
        if error.code == "CONSENT_GRANT_NOT_FOUND" and user_id:
            return {
                "success": False,
                "stage": "signing",
                "code": "CONSENT_REQUIRED",
                "serviceId": service["id"],
                "detail": (
                    f"Consent required: {user['name']} has not let {persona.display_name} (or any agent that delegated to it) "
                    f"use {service['name']}. HelixID refused to sign a presentation on their behalf."
                ),
                "consentRequired": _consent_prompt(service["id"], user_id),
            }
        return {
            "success": False,
            "stage": "signing",
            "code": error.code,
            "serviceId": service["id"],
            "detail": f"Refused by HelixID while signing the presentation [{error.code}]: {error.message}",
        }

    result = present_vp(service["id"], tool_name, input, vp)
    if not result["success"] and result.get("code") == "CONSENT_REQUIRED" and user_id:
        result["consentRequired"] = _consent_prompt(service["id"], user_id)
    return result
