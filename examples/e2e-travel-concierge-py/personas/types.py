# A "persona" is a selectable onboarded-agent context: its own DID, its own key
# (self custody, in its key directory on the shared volume), the scopes its
# card attests, and the delegation chain it carries at the service. Python port
# of ../personas/types.ts -- the JSON shape (camelCase keys) must match exactly:
# the manifest on the shared volume is written by the JS seeder and read here.

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

Hop = Dict[str, Any]


@dataclass
class Persona:
    id: str
    display_name: str
    # What its Entity Card attests. Authority never exceeds it.
    scopes: List[str]
    agent_did: str
    # Its identity credential: revoking it revokes the agent.
    vc_id: str = ""
    # The chain it carries at the service, root first; None: no authority there.
    chain: Optional[List[Hop]] = None
    # Its own status list (a self-custody issuer of hops signs it), once it has delegated.
    status_list: Optional[str] = None
    delegated_from_persona_id: Optional[str] = None
    delegated_scopes: Optional[List[str]] = None
    revoked_at: Optional[str] = None
    extra: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {**self.extra, "id": self.id, "displayName": self.display_name, "scopes": self.scopes, "agentDid": self.agent_did, "vcId": self.vc_id}
        for key, value in (
            ("chain", self.chain),
            ("statusList", self.status_list),
            ("delegatedFromPersonaId", self.delegated_from_persona_id),
            ("delegatedScopes", self.delegated_scopes),
            ("revokedAt", self.revoked_at),
        ):
            if value is not None:
                d[key] = value
        return d

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "Persona":
        known = {"id", "displayName", "scopes", "agentDid", "vcId", "chain", "statusList", "delegatedFromPersonaId", "delegatedScopes", "revokedAt"}
        return Persona(
            id=d["id"],
            display_name=d["displayName"],
            scopes=list(d.get("scopes") or []),
            agent_did=d["agentDid"],
            vc_id=d.get("vcId") or "",
            chain=d.get("chain"),
            status_list=d.get("statusList"),
            delegated_from_persona_id=d.get("delegatedFromPersonaId"),
            delegated_scopes=d.get("delegatedScopes"),
            revoked_at=d.get("revokedAt"),
            extra={k: v for k, v in d.items() if k not in known},
        )

    def to_public(self) -> Dict[str, Any]:
        leaf = (self.chain or [None])[-1]
        authority = list(((leaf or {}).get("credentialSubject") or {}).get("allowedAction") or [])
        d: Dict[str, Any] = {"id": self.id, "displayName": self.display_name, "scopes": self.scopes, "authority": authority}
        if self.delegated_from_persona_id is not None:
            d["delegatedFromPersonaId"] = self.delegated_from_persona_id
        if self.delegated_scopes is not None:
            d["delegatedScopes"] = self.delegated_scopes
        return d
