# Shared enrollment, Python port of ../personas/enroll.ts. Used by the agent's
# runtime onboarding route (POST /onboard-agent) and the delegation demo; the
# initial Concierge persona is seeded by the JS helixid-setup service (see
# docker-compose.yml), whose manifest entry and key directory this reads
# unchanged.
#
# helixid is self custody: the admin creates the agent (POST /v1/agents,
# keyCustody 'self'), and helix_init generates the agent's key locally, proves
# it to HelixID with the enrollment token and writes the DID document, card and
# signing key to the persona's key directory. Only the public key is sent.
# With own_authority (default), its responsible party then issues the root hop
# of its chain at the service (admin POST /v1/grants).

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

from config import env, key_dir_for
from helix_sdk.custody import helix_init
from helixid import admin, helix_fetch_json
from personas.types import Hop, Persona
from service.identity import load_service


@dataclass
class EnrollInput:
    id: str
    display_name: str
    scopes: List[str]
    bootstrap_token: Optional[str] = None
    own_authority: bool = True


@dataclass
class EnrollResult:
    persona: Persona
    vc_id: str
    did: str


def _responsible_party_of(card: dict, vc_id: Optional[str]) -> str:
    if card.get("responsibleParty"):
        return card["responsibleParty"]
    if vc_id:
        vc = (admin("GET", f"/v1/vcs/{vc_id}") or {}).get("vc") or {}
        party = (vc.get("credentialSubject") or {}).get("responsibleParty")
        if party:
            return party
    raise RuntimeError("the agent has no responsible party to root its chain")


def issue_root_hop(agent_did: str, responsible_party: str, allowed_action: List[str]) -> Hop:
    service = load_service()
    return admin("POST", "/v1/grants", {"issuer": responsible_party, "invoker": agent_did, "invocationTarget": service.did, "allowedAction": allowed_action})["hop"]


def enroll_persona(input: EnrollInput) -> EnrollResult:
    token = input.bootstrap_token or admin("POST", "/v1/agents", {"name": input.display_name, "scopes": input.scopes, "keyCustody": "self"}).get("enrollmentToken")
    if not token:
        raise RuntimeError("POST /v1/agents answered without an enrollment token")
    init = helix_init(env.helix_api_url, token, key_dir_for(input.id))
    card = helix_fetch_json(init.card_url)
    scopes = [c["name"] for c in card.get("capabilities") or []]
    chain = None
    if input.own_authority and scopes:
        chain = [issue_root_hop(init.did, _responsible_party_of(card, init.vc_id), scopes)]
    persona = Persona(id=input.id, display_name=input.display_name, scopes=scopes, agent_did=init.did, vc_id=init.vc_id or "", chain=chain)
    return EnrollResult(persona=persona, vc_id=init.vc_id or "", did=init.did)
