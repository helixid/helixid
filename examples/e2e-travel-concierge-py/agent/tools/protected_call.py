# The single choke point where a tool call is signed, Python port of
# ../../e2e-travel-concierge/agent/tools/protectedCall.ts (KYA-OS stories C-C,
# F-2). The selected persona signs a request proof with its own key (self
# custody, locally) naming the service as audience, and carries the chain it
# holds there. The MCP server verifies both in-process.

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from agent.mcp_client import send_mcp_call
from helix_sdk.request_proof import with_request_proof
from personas.keys import publish_own_status_list, signer_of
from personas.store import get_persona
from personas.types import Persona
from service.identity import load_service


@dataclass
class ProtectedResult:
    success: bool
    detail: str
    code: Optional[str] = None
    data: Any = None
    extra: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {"success": self.success, "detail": self.detail}
        if self.code is not None:
            d["code"] = self.code
        if self.data is not None:
            d["data"] = self.data
        return d


def call_protected_tool(persona: Persona, tool_name: str, input: Dict[str, Any]) -> ProtectedResult:
    service = load_service()
    # A hop a self-custody agent delegated is read against that agent's own list, which it keeps signed.
    delegator = get_persona(persona.delegated_from_persona_id) if persona.delegated_from_persona_id else None
    for hop in (persona.chain or [])[1:]:
        if delegator is not None and delegator.agent_did == hop.get("issuer"):
            publish_own_status_list(delegator)
    call = with_request_proof(
        {"method": "tools/call", "params": {"name": tool_name, "arguments": input}},
        signer_of(persona),
        audience=service.did,
        chain=persona.chain or None,
    )
    result = send_mcp_call(call)
    # Surface the real result (success or the real refusal) so the model reports
    # it truthfully -- the agent never writes the outcome itself.
    if result.is_error:
        return ProtectedResult(success=False, detail=result.text, code=(result.structured or {}).get("code") or "REFUSED")
    return ProtectedResult(success=True, detail=result.text, data=result.structured)
