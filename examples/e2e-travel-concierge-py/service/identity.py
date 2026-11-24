# The MCP service's identity, Python port of
# ../../e2e-travel-concierge/service/identity.ts: a service enrolled on HelixID
# (admin POST /v1/services) that keeps its own key (self custody) while
# HelixID hosts its did:web. The (JS) seeder enrolls it and writes the
# identity to the shared volume; the MCP server signs every answer with it.

from __future__ import annotations

import json
from dataclasses import dataclass


from config import env


@dataclass
class ServiceIdentity:
    did: str
    # The service's Ed25519 private key (hex): key-1 of its did:web document.
    signing_key: str


def load_service() -> ServiceIdentity:
    try:
        with open(env.service_identity_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError as error:
        raise RuntimeError(f"No service identity at {env.service_identity_path}: run the seeder (helixid-setup) first.") from error
    return ServiceIdentity(did=raw["did"], signing_key=raw["signingKey"])
