# The single choke point where a verifiable presentation is created, Python
# port of ../../e2e-travel-concierge/agent/tools/protectedCall.ts. It loads
# the *selected persona's* wallet, picks either its default credential or the
# delegated credential selected by Use case 4, and signs a fresh VP bound to
# the MCP server. The private key is decrypted in-process and never
# transmitted.

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict

from agent.mcp_client import call_mcp_tool
from config import USER_DID, TARGET_SERVICE, env
from helix_sdk.client import HelixClient
from personas.types import Persona


@dataclass
class ProtectedResult:
    success: bool
    detail: str


def call_protected_tool(persona: Persona, tool_name: str, input: Dict[str, Any]) -> ProtectedResult:
    client = HelixClient(env.helix_api_url, admin_api_key=env.admin_api_key)

    # With no active_credential_id the server picks the persona's single
    # active credential itself; once delegation has given it a second one,
    # the choice has to be explicit.
    vp = client.sign_vp(
        persona.agent_did,
        TARGET_SERVICE,
        user_did=USER_DID,
        vc_id=persona.active_credential_id,
    )

    result = call_mcp_tool(tool_name, {**input, "_helixVP": vp})
    # Surface the real result (success or the real rejection reason) so the
    # model can report it truthfully -- the agent never writes the outcome
    # itself.
    return ProtectedResult(success=not result.is_error, detail=result.text)
