# Shared enrollment used by the seeder (initial Concierge) and the agent's
# runtime onboarding route (every scenario's agents). Mints a one-use
# enrollment token (or consumes one generated in Console) and onboards via
# POST /v1/onboard: the server generates and holds the agent's key, so
# nothing local is created and no passphrase is involved. Nothing here is
# stubbed.

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional
from urllib.parse import quote

from personas.platform import admin_call, describe_api_error
from personas.types import Persona


@dataclass
class EnrollInput:
    id: str
    display_name: str
    scopes: List[str]
    max_delegation_depth: Optional[int] = None
    group: Optional[str] = None
    # If omitted, a one-use token is minted from `scopes`.
    bootstrap_token: Optional[str] = None


@dataclass
class EnrollResult:
    persona: Persona
    vc_id: str
    did: str


def _mint_token(display_name: str, scopes: List[str], max_delegation_depth: int = 0) -> str:
    result = admin_call(
        "/v1/enrollment-tokens",
        {"agentName": display_name, "requestedScopes": scopes, "requestedDomains": [], "maxDelegationDepth": max_delegation_depth},
    )
    token = result["body"].get("token")
    if not result["ok"] or not token:
        raise RuntimeError(f"Failed to mint enrollment token: {describe_api_error(result['body'].get('error'), result['status'])}")
    return token


def enroll_persona(input: EnrollInput) -> EnrollResult:
    token = input.bootstrap_token or _mint_token(input.display_name, input.scopes, input.max_delegation_depth or 0)
    onboarded = admin_call("/v1/onboard", {"enrollmentToken": token, "domains": []})
    agent_did, vc_id = onboarded["body"].get("agentDid"), onboarded["body"].get("vcId")
    if not onboarded["ok"] or not agent_did or not vc_id:
        raise RuntimeError(f"Onboarding failed: {describe_api_error(onboarded['body'].get('error'), onboarded['status'])}")

    # Trust the credential's actual scopes (a supplied token may differ from the
    # requested scopes). The platform holds the credential, so this reads it back.
    issued = admin_call(f"/v1/vcs/{quote(vc_id, safe='')}", method="GET")
    scopes = ((issued["body"].get("vc") or {}).get("credentialSubject") or {}).get("privilegeScopes") or input.scopes
    persona = Persona(
        id=input.id,
        display_name=input.display_name,
        scopes=scopes,
        did=agent_did,
        vc_id=vc_id,
        max_delegation_depth=input.max_delegation_depth,
        group=input.group,
    )
    return EnrollResult(persona=persona, vc_id=vc_id, did=agent_did)
