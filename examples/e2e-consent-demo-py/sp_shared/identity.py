# SP identity provisioning. Python port of
# examples/e2e-consent-demo/sp-shared/identity.ts.
#
# provision_sp_identity() is called once by the seeder; each SP server calls
# load_sp_identity() on boot and hosts what it finds.

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from typing import Any, Dict, Tuple

from helix_sdk.keys import generate_key_pair

from helixid_config import sp_did_for
from sp_shared.status_list import build_status_list_credential, create_status_list

# Generous by design: grant indices are assigned randomly, unused bits are free.
STATUS_LIST_LENGTH = 131072


@dataclass
class SpIdentityFile:
    did: str
    privateKeyHex: str
    publicKeyHex: str
    statusListUrl: str
    baseUrl: str


def _identity_path(directory: str, sp_id: str) -> str:
    return os.path.join(directory, f"sp-{sp_id}.identity.json")


def state_path(directory: str, sp_id: str) -> str:
    return os.path.join(directory, f"sp-{sp_id}.state.json")


def provision_sp_identity(
    directory: str, sp_id: str, host: str, port: int
) -> Tuple[SpIdentityFile, Dict[str, Any], bool]:
    path = _identity_path(directory, sp_id)
    state_file = state_path(directory, sp_id)

    if os.path.exists(path) and os.path.exists(state_file):
        with open(path, "r", encoding="utf-8") as f:
            identity = SpIdentityFile(**json.load(f))
        with open(state_file, "r", encoding="utf-8") as f:
            status_list = json.load(f)["statusList"]
        return identity, status_list, False

    key_pair = generate_key_pair()
    did = sp_did_for(host, port)
    base_url = f"http://{host}:{port}"
    status_list_url = f"{base_url}/status-list/1"

    identity = SpIdentityFile(
        did=did,
        privateKeyHex=key_pair.private_key,
        publicKeyHex=key_pair.public_key,
        statusListUrl=status_list_url,
        baseUrl=base_url,
    )

    # Same shared StatusListCredential shape helix-api uses for its own lists.
    status_list = build_status_list_credential("1", create_status_list(STATUS_LIST_LENGTH), did, base_url)

    os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(asdict(identity), f, indent=2)

    return identity, status_list, True


def load_sp_identity(directory: str, sp_id: str) -> SpIdentityFile:
    path = _identity_path(directory, sp_id)
    try:
        with open(path, "r", encoding="utf-8") as f:
            return SpIdentityFile(**json.load(f))
    except FileNotFoundError as exc:
        raise RuntimeError(
            f'SP "{sp_id}" is not provisioned ({path} not found). Run the seeder first: python -m seed.seed'
        ) from exc
