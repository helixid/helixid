# Deliberately misbehaving agent actions for the attack scenarios. Each one
# starts from a genuine, platform-signed VP and then does what a compromised
# agent or a network attacker would: send it twice, edit it, or present it to
# a service it wasn't made for. None of this can make HelixID accept it --
# that's the point of the scenario.

from __future__ import annotations

import copy
import uuid
from typing import Any, Dict, List

from agent.services import get_service
from agent.tools.protected_call import SigningRefusedError, present_vp, sign_vp
from config import service_for_tool
from personas.types import Persona

# Captured VPs live only in this process's memory, and only for the demo.
_captures: Dict[str, Dict[str, Any]] = {}


def _refused_while_signing(error: SigningRefusedError) -> Dict[str, Any]:
    return {"success": False, "stage": "signing", "code": error.code, "detail": f"Refused by HelixID while signing [{error.code}]: {error.message}"}


def _unknown_tool(tool_name: str) -> Dict[str, Any]:
    return {"success": False, "code": "UNKNOWN_TOOL", "detail": f"Unknown tool: {tool_name}"}


def capture_and_send(persona: Persona, tool_name: str, input: Dict[str, Any]) -> Dict[str, Any]:
    """Signs one VP, uses it once (legitimately), and keeps a copy -- as an eavesdropper would."""
    definition = service_for_tool(tool_name)
    if definition is None:
        return _unknown_tool(tool_name)
    service = get_service(definition.id)
    try:
        vp = sign_vp(persona, service["did"])
    except SigningRefusedError as error:
        return _refused_while_signing(error)
    capture_id = str(uuid.uuid4())
    _captures[capture_id] = {"serviceId": service["id"], "toolName": tool_name, "input": input, "vp": vp}
    return {**present_vp(service["id"], tool_name, input, vp), "captureId": capture_id, "vpId": vp.get("id")}


def replay(capture_id: str) -> Dict[str, Any]:
    """Presents a previously captured VP again, byte for byte."""
    capture = _captures.get(capture_id)
    if capture is None:
        return {"success": False, "code": "UNKNOWN_CAPTURE", "detail": "No captured presentation with that id (the agent process may have restarted)."}
    return present_vp(capture["serviceId"], capture["toolName"], capture["input"], capture["vp"])


def tamper_and_send(persona: Persona, tool_name: str, input: Dict[str, Any], add_scopes: List[str]) -> Dict[str, Any]:
    """Signs a genuine VP, then edits the agent credential inside it to claim
    extra scopes -- what an agent trying to promote itself would do. The
    issuer's signature over the credential no longer matches."""
    definition = service_for_tool(tool_name)
    if definition is None:
        return _unknown_tool(tool_name)
    service = get_service(definition.id)
    try:
        vp = sign_vp(persona, service["did"])
    except SigningRefusedError as error:
        return _refused_while_signing(error)
    tampered = copy.deepcopy(vp)
    agent_vc = next((vc for vc in tampered.get("verifiableCredential") or [] if "HelixAgentCredential" in (vc.get("type") or [])), None)
    if agent_vc is None:
        return {"success": False, "code": "NO_AGENT_VC", "detail": "The VP carried no agent credential to tamper with."}
    subject = agent_vc.setdefault("credentialSubject", {})
    subject["privilegeScopes"] = sorted(set(subject.get("privilegeScopes") or []) | set(add_scopes))
    return {**present_vp(service["id"], tool_name, input, tampered), "tamperedVcId": agent_vc.get("id")}


def present_to_wrong_service(persona: Persona, sign_for_service_id: str, tool_name: str, input: Dict[str, Any]) -> Dict[str, Any]:
    """Signs a genuine VP for one service and presents it to another -- e.g. a
    malicious Helix Stay forwarding a VP it received to Helix Air. The VP's
    `targetService` names the service it was made for."""
    definition = service_for_tool(tool_name)
    if definition is None:
        return _unknown_tool(tool_name)
    signed_for = get_service(sign_for_service_id)
    try:
        vp = sign_vp(persona, signed_for["did"])
    except SigningRefusedError as error:
        return _refused_while_signing(error)
    return present_vp(definition.id, tool_name, input, vp)


