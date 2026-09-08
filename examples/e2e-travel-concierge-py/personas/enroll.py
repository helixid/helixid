# Shared enrollment, Python port of ../personas/enroll.ts. Used by the
# agent's runtime onboarding route (POST /onboard-agent) and the delegation
# demo. The initial Concierge persona is instead seeded by the still-JS
# helixid-setup service (see docker-compose.yml) -- its output (an encrypted
# wallet + a personas.json entry) is consumed here unchanged, since
# helix-sdk-py's wallet file format is byte-for-byte compatible with
# helix-sdk-js's.
#
# Either way, this creates a local did:key wallet and enrolls via the live
# POST /v1/enroll. Nothing here is stubbed.

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

import requests

from config import env
from helix_sdk.client import HelixClient
from personas.types import Persona


@dataclass
class EnrollInput:
    id: str
    display_name: str
    scopes: List[str]
    max_delegation_depth: int = 0
    bootstrap_token: Optional[str] = None


@dataclass
class EnrollResult:
    persona: Persona
    vc_id: str
    did: str


def _mint_token(display_name: str, scopes: List[str], max_delegation_depth: int = 0) -> str:
    res = requests.post(
        f"{env.helix_api_url}/v1/enrollment-tokens",
        json={
            "agentName": display_name,
            "requestedScopes": scopes,
            "requestedDomains": [],
            "maxDelegationDepth": max_delegation_depth,
        },
        timeout=15,
    )
    body = res.json() if res.content else {}
    token = body.get("token") if isinstance(body, dict) else None
    if not res.ok or not token:
        raise RuntimeError(f"Failed to mint enrollment token: HTTP {res.status_code} {body}")
    return token


def enroll_persona(input: EnrollInput) -> EnrollResult:
    token = input.bootstrap_token or _mint_token(input.display_name, input.scopes, input.max_delegation_depth)

    client = HelixClient(env.helix_api_url, admin_api_key=env.admin_api_key)
    identity = client.onboard_agent(token, [])
    agent_did = identity["agentDid"]
    vc_id = identity["vcId"]

    # Trust the credential's actual scopes (a supplied token may differ from
    # the requested scopes). The platform holds the credential, so this reads
    # it back rather than inspecting a locally-held copy.
    issued = (client.get_vc(vc_id) or {}).get("vc") or {}
    subject = issued.get("credentialSubject") or {}
    scopes = subject.get("privilegeScopes") or input.scopes
    persona = Persona(id=input.id, display_name=input.display_name, scopes=scopes, agent_did=agent_did)
    return EnrollResult(persona=persona, vc_id=vc_id, did=agent_did)
