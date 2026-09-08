# A "persona" is a selectable onboarded-agent context: its own DID, its own
# credential, its own scopes. Switching personas in the UI switches which
# agent the API signs the next protected tool call for. Python port of
# ../personas/types.ts -- the JSON shape (camelCase keys) must match exactly:
# the manifest on the shared volume is written by the still-JS helixid-setup
# seeder and read by this Python agent.
#
# Agent self-custody is retired, so a persona owns no wallet and no key -- it
# is identified by its DID, and the server holds the key.

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional


@dataclass
class Persona:
    id: str
    display_name: str
    scopes: List[str]
    agent_did: str
    active_credential_id: Optional[str] = None
    delegated_from_persona_id: Optional[str] = None
    delegated_scopes: Optional[List[str]] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {
            "id": self.id,
            "displayName": self.display_name,
            "scopes": self.scopes,
            "agentDid": self.agent_did,
        }
        if self.active_credential_id is not None:
            d["activeCredentialId"] = self.active_credential_id
        if self.delegated_from_persona_id is not None:
            d["delegatedFromPersonaId"] = self.delegated_from_persona_id
        if self.delegated_scopes is not None:
            d["delegatedScopes"] = self.delegated_scopes
        return d

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "Persona":
        return Persona(
            id=d["id"],
            display_name=d["displayName"],
            scopes=list(d.get("scopes") or []),
            agent_did=d["agentDid"],
            active_credential_id=d.get("activeCredentialId"),
            delegated_from_persona_id=d.get("delegatedFromPersonaId"),
            delegated_scopes=d.get("delegatedScopes"),
        )

    def to_public(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {"id": self.id, "displayName": self.display_name, "scopes": self.scopes}
        if self.delegated_from_persona_id is not None:
            d["delegatedFromPersonaId"] = self.delegated_from_persona_id
        if self.delegated_scopes is not None:
            d["delegatedScopes"] = self.delegated_scopes
        return d
