# A "persona" is a selectable onboarded-agent context: its own DID, its own
# credential, its own scopes, owned by one organization. Switching personas in
# the UI switches which agent presents the next protected tool call. There is
# no local key material anywhere in this app -- agent self-custody is retired,
# so the server generates and holds each agent's key, and every VP is signed
# via POST /v1/agents/:did/vp (see agent/tools/protected_call.py). That route is
# admin-gated in OSS, so the agent service holds the admin key.

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class Persona:
    id: str
    display_name: str
    # Scopes the credential carries (informational -- enforcement is server-side).
    scopes: List[str]
    # The agent's DID, from POST /v1/onboard -- identifies it to sign_vp, never a key.
    did: str
    # The credential id POST /v1/onboard issued alongside `did`.
    vc_id: str
    # Unused on a self-hosted server (no accounts); kept so the shared UI reads the same shape.
    org: Optional[str] = None
    visibility: Optional[str] = None
    # Set once a delegation lands this persona a delegated credential (see
    # /delegate-agent). The server presents it alongside `vc_id` on every VP.
    delegated_vc_id: Optional[str] = None
    delegated_scopes: Optional[List[str]] = None
    delegated_by: Optional[str] = None
    delegation_expires_at: Optional[str] = None
    # Set when the delegated credential was revoked (by the delegator, or by an unpublish).
    delegation_revoked_at: Optional[str] = None
    # The root credential's delegation budget (0 = may not delegate).
    max_delegation_depth: Optional[int] = None
    # Which guided scenario created this persona -- only used to group the UI's agent list.
    group: Optional[str] = None
    # Informational lifecycle flags, set by this app's revoke/deactivate routes.
    revoked_at: Optional[str] = None
    deactivated_at: Optional[str] = None

    # (camelCase manifest key, python attribute)
    _FIELDS = [
        ("id", "id"),
        ("displayName", "display_name"),
        ("scopes", "scopes"),
        ("did", "did"),
        ("vcId", "vc_id"),
        ("org", "org"),
        ("visibility", "visibility"),
        ("delegatedVcId", "delegated_vc_id"),
        ("delegatedScopes", "delegated_scopes"),
        ("delegatedBy", "delegated_by"),
        ("delegationExpiresAt", "delegation_expires_at"),
        ("delegationRevokedAt", "delegation_revoked_at"),
        ("maxDelegationDepth", "max_delegation_depth"),
        ("group", "group"),
        ("revokedAt", "revoked_at"),
        ("deactivatedAt", "deactivated_at"),
    ]

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {}
        for key, attr in self._FIELDS:
            value = getattr(self, attr)
            if value is not None:
                d[key] = value
        return d

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "Persona":
        kwargs: Dict[str, Any] = {attr: d.get(key) for key, attr in Persona._FIELDS}
        kwargs["scopes"] = list(d.get("scopes") or [])
        # A manifest from the previous version of this demo named the DID `agentDid`.
        kwargs["did"] = kwargs.get("did") or d.get("agentDid") or ""
        kwargs["vc_id"] = kwargs.get("vc_id") or d.get("activeCredentialId") or ""

        return Persona(**kwargs)

    def to_public(self) -> Dict[str, Any]:
        """The projection sent to the browser -- just enough to pick and label a persona. Never a credential id."""
        d = self.to_dict()
        d.pop("vcId", None)
        d.pop("delegatedVcId", None)
        d["org"] = org_of(self)
        d["visibility"] = self.visibility or "private"
        return d


def org_of(persona: Persona) -> str:
    return persona.org or "a"
