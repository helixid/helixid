# The SP's KYA-OS gate (stories F-2, C-C, L3-E, L3-H), one per SP. Python port
# of sp-shared/kyaos-gate.ts.
#
# Every tools/call carries a request proof the agent signed and, once the
# user consented, its delegation chain: the root hop the user's own did:key
# signed on Helix's consent page. The SP verifies both in-process with
# helix_mcp_middleware's local verifier (no call to Helix: the cross-border
# rule). A call without the user's authority gets the signed
# needs_authorization challenge, whose authorizationUrl is Helix's consent
# page for a consent request this SP signed (create_helix_consent). Every
# answer carries this SP's response proof, so the agent can check that the
# consent URL it shows the user is the one this SP sent.
#
# The SP keeps its own key (self custody, its did:web hosted by Helix): it
# signs its consent requests and its response proofs. It holds no key able to
# sign as a user.

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence

import requests

from helix_mcp_middleware import (
    MemoryResumeTokenStore,
    NeedsAuthorization,
    NeedsAuthorizationOptions,
    attach_response_proof,
    build_response_proof,
    challenge_tool_result,
    consent_retry_authorizer,
    create_helix_consent,
    create_local_verifier,
    create_needs_authorization,
)
from helix_sdk.crypto.jws import EnvSigner
from helix_sdk.handshake import generate_nonce
from helix_sdk.response_proof import RESPONSE_PROOF_ENVELOPE_PROFILE, hash_request, hash_response


@dataclass
class Verdict:
    ok: bool
    agent_did: Optional[str] = None
    # The user's did:key that signed the root hop, when the call carried one.
    user_did: Optional[str] = None
    scopes: Optional[List[str]] = None
    level: Optional[str] = None
    code: Optional[str] = None
    message: Optional[str] = None


def _helix_status_list_binding(helix_api_url: str) -> Optional[Dict[str, List[str]]]:
    """The Helix issuer keeps its own list: what a service binds so an agent card's revocation entry is read (SPEC-ENTITY-CARD §10.3)."""
    try:
        issuer = requests.get(f"{helix_api_url}/health", timeout=10).json().get("issuerDid")
    except Exception:  # noqa: BLE001
        return None
    return {issuer: [f"{helix_api_url}/v1/status-list/helix-status-list-1"]} if issuer else None


class Gate:
    def __init__(
        self,
        service_did: str,
        signing_key: str,
        helix_api_url: str,
        display_name: str,
        catalog: Sequence[str],
        window_seconds: int,
        hop_lifetime_seconds: int,
        allow_loopback_http: bool,
    ) -> None:
        self.service_did = service_did
        self._signer = EnvSigner(service_did, kid="key-1", env_var="SP_KEY", env={"SP_KEY": signing_key})
        settings: Dict[str, Any] = {
            "service_did": service_did,
            "catalog": list(catalog),
            "allow_loopback_http": allow_loopback_http,
            "log": lambda _message: None,
        }
        status_list_issuers = _helix_status_list_binding(helix_api_url)
        if status_list_issuers is not None:
            settings["status_list_issuers"] = status_list_issuers
        self.verifier = create_local_verifier(**settings)
        consent = create_helix_consent(
            helix_api_url,
            service_did,
            self._signer,
            window_seconds,
            hop_lifetime_seconds=hop_lifetime_seconds,
            display={"serviceName": display_name},
        )
        self.needs_authorization: NeedsAuthorization = create_needs_authorization(
            NeedsAuthorizationOptions(
                authorization_url=consent.authorization_url,
                authorizer=consent_retry_authorizer(self.verifier),
                store=MemoryResumeTokenStore(),
                service_did=service_did,
            )
        )

    def verify(self, request: Mapping[str, Any]) -> Verdict:
        """The call's agent and what it may do here: its own proof, and the chain the user signed."""
        params = request.get("params") or {}
        result = self.verifier.verify_call(
            {"name": params.get("name"), "input": params.get("arguments"), "_meta": params.get("_meta"), "request": request, "live_status": True}
        )
        if result is None:
            return Verdict(ok=False, code="proof_missing", message="the call carries no request proof")
        if not result.ok or result.agent_did is None:
            return Verdict(ok=False, code=(result.reasons or ["refused"])[0], message="; ".join(result.messages))
        root = result.chain_summary.responsible_party
        return Verdict(
            ok=True,
            agent_did=result.agent_did,
            user_did=root if isinstance(root, str) and root.startswith("did:key:") else None,
            scopes=list(result.effective_scopes),
            level=result.level,
        )

    def challenge(self, agent_did: str, tool: str, scope: str, service_user_id: str) -> Dict[str, Any]:
        """The signed challenge for a call lacking ``scope``, for the user this SP names."""
        return self.needs_authorization.challenge(agent_did=agent_did, tool=tool, scopes=[scope], oauth_subject=service_user_id).challenge

    def sign(self, request: Mapping[str, Any], result: Dict[str, Any], outcome: str, client_did: Optional[str] = None) -> Dict[str, Any]:
        """``result`` with this SP's response proof."""
        meta: Dict[str, Any] = {
            "did": self.service_did,
            "kid": f"{self.service_did}#key-1",
            "ts": int(time.time()),
            "nonce": generate_nonce(),
            "audience": self.service_did,
            "sessionId": "none",
            "requestHash": hash_request(request),
            "outcome": outcome,
        }
        if outcome != "denied":
            meta["responseHash"] = hash_response(result, RESPONSE_PROOF_ENVELOPE_PROFILE)
            meta["prf"] = RESPONSE_PROOF_ENVELOPE_PROFILE
        if client_did is not None:
            meta["clientDid"] = client_did
        return attach_response_proof(result, build_response_proof(meta, self._signer))


__all__ = ["Gate", "Verdict", "challenge_tool_result"]
