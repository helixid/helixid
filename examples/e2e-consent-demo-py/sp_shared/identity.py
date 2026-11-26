# SP identity: a service enrolled at HelixID (admin POST /v1/services) that
# keeps its own key (self custody) while HelixID hosts its did:web
# (did:web:<api-host>:services:<hex>). The SP signs its consent requests and
# its response proofs with that key (KYA-OS stories L2-A, L3-H); HelixID never
# sees it. The seeder writes the identity and the key to a small local JSON
# file once (a demo: a real service keeps its key in a secret store).
# Python port of examples/e2e-consent-demo/sp-shared/identity.ts.

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from typing import Tuple

import requests

from helix_sdk.crypto.jws import public_key_hex_to_jwk
from helix_sdk.keys import generate_key_pair

from helixid_config import SpDefinition


@dataclass
class SpIdentityFile:
    serviceId: str
    did: str
    baseUrl: str
    # The SP's Ed25519 private key (hex): key-1 of its did:web document.
    signingKey: str


def _identity_path(directory: str, sp_id: str) -> str:
    return os.path.join(directory, f"sp-{sp_id}.identity.json")


def enroll_sp_service(
    directory: str, definition: SpDefinition, host: str, port: int, helix_api_url: str, admin_api_key: str
) -> Tuple[SpIdentityFile, bool]:
    """Enrolls the SP once (its own key, Helix-hosted did:web); answers (identity, created)."""
    path = _identity_path(directory, definition.id)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return SpIdentityFile(**json.load(f)), False

    base_url = f"http://{host}:{port}"
    keys = generate_key_pair()
    response = requests.post(
        f"{helix_api_url}/v1/services",
        json={
            # Service names are unique across a Helix deployment, so the enrolled
            # name carries this SP's address; the consent page shows the
            # display name the SP sends with each consent request instead.
            "name": f"{definition.display_name} ({host}:{port})",
            "domain": f"{host}:{port}",
            "requiredScopes": [entry.scope for entry in definition.scope_catalog],
            "description": f"{definition.display_name} (e2e-consent-demo-py)",
            "framework": "flask",
            "keyCustody": "self",
            "didHosting": "helix",
            "publicKeyJwk": public_key_hex_to_jwk(keys.public_key),
        },
        headers={"x-admin-api-key": admin_api_key},
        timeout=15,
    )
    body = response.json() if response.content else {}
    service_id = body.get("id") or (body.get("service") or {}).get("id")
    if not response.ok or not service_id or not body.get("did"):
        error = body.get("error") if isinstance(body.get("error"), dict) else {}
        raise RuntimeError(error.get("message") or f"service enrollment failed: HTTP {response.status_code}")

    identity = SpIdentityFile(serviceId=service_id, did=body["did"], baseUrl=base_url, signingKey=keys.private_key)
    os.makedirs(directory, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as f:
        json.dump(asdict(identity), f, indent=2)
    return identity, True


def load_sp_identity(directory: str, sp_id: str) -> SpIdentityFile:
    path = _identity_path(directory, sp_id)
    try:
        with open(path, "r", encoding="utf-8") as f:
            return SpIdentityFile(**json.load(f))
    except FileNotFoundError as exc:
        raise RuntimeError(f'SP "{sp_id}" is not enrolled ({path} not found). Run: python -m seed.seed') from exc
