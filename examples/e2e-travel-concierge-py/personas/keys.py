# A persona's own key (self custody), Python port of ../personas/keys.ts: the
# signing-key.env helix init wrote to its key directory. Everything the agent
# signs -- its request proofs, the hops it delegates, its own status list -- is
# signed here, locally.

from __future__ import annotations

import os
import re
import uuid
from typing import Any, Dict, List, Tuple

from config import key_dir_for
from helix_sdk.credentials import sign_data_integrity
from helix_sdk.crypto.jws import EnvSigner
from helixid import admin
from personas.types import Hop, Persona

_ENV_VAR = "HELIX_SIGNING_KEY"


def signer_of(persona: Persona) -> EnvSigner:
    with open(os.path.join(key_dir_for(persona.id), "signing-key.env"), "r", encoding="utf-8") as f:
        match = re.search(rf"^{_ENV_VAR}=([0-9a-fA-F]+)\s*$", f.read(), re.M)
    if not match:
        raise RuntimeError(f"No {_ENV_VAR} in {persona.id}'s signing-key.env")
    return EnvSigner(persona.agent_did, kid="key-1", env_var=_ENV_VAR, env={_ENV_VAR: match.group(1)})


def publish_own_status_list(persona: Persona) -> None:
    """A self-custody issuer signs its own status list (KYA-OS L3-C): HelixID
    hosts it but serves nothing until the issuer has signed the current bits."""
    if not persona.status_list:
        return
    unsigned = dict(admin("GET", f"/v1/status-list/{persona.status_list}/unsigned"))
    unsigned.pop("proof", None)
    admin("PUT", f"/v1/status-list/{persona.status_list}", sign_data_integrity(unsigned, signer_of(persona)))


def delegate_hop(from_persona: Persona, parent: List[Hop], invoker: str, allowed_action: List[str], valid_until: str) -> Tuple[Hop, str]:
    """The delegator's hop to ``invoker`` under the chain it holds, signed with
    its own key, with an entry on its own status list (admin POST
    /v1/status-list/entries)."""
    leaf = parent[-1]
    entry: Dict[str, Any] = admin("POST", "/v1/status-list/entries", {"issuer": from_persona.agent_did})
    hop_id = f"urn:zcap:{uuid.uuid4()}"
    unsigned = {
        "@context": leaf.get("@context"),
        "type": ["VerifiableCredential", "DelegationCredential"],
        "issuer": from_persona.agent_did,
        "validUntil": valid_until,
        "id": hop_id,
        "credentialSubject": {
            "invoker": invoker,
            "parentCapability": leaf["id"],
            "invocationTarget": (leaf.get("credentialSubject") or {}).get("invocationTarget"),
            "allowedAction": allowed_action,
            "id": hop_id,
        },
        "credentialStatus": {
            "type": "BitstringStatusListEntry",
            "statusPurpose": "revocation",
            "statusListIndex": entry["statusListIndex"],
            "statusListCredential": entry["statusListCredential"],
            "id": f"{entry['statusListCredential']}#{entry['statusListIndex']}",
        },
    }
    hop = sign_data_integrity(unsigned, signer_of(from_persona))
    return hop, entry["statusListCredential"].rsplit("/", 1)[-1]
