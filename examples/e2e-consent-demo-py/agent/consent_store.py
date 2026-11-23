# The agent's consents, one per SP: the root hop the user's did:key signed on
# Helix's consent page, the consent id and the window (KYA-OS story L3-H).
# Kept in a small local JSON file next to the agent's identity. The hop is
# useless without the agent's own key, so this file holds no secret.
# Python port of agent/consentStore.ts.

from __future__ import annotations

import json
import os
import threading
from typing import Any, Dict, Optional


class ConsentStore:
    """Entries: {serviceDid, consentId, hop, windowUntil (Unix seconds), helixUrl}, keyed by serviceDid."""

    def __init__(self, path: str) -> None:
        self._path = path
        self._lock = threading.Lock()
        self._cache: Optional[Dict[str, Dict[str, Any]]] = None

    def _all(self) -> Dict[str, Dict[str, Any]]:
        if self._cache is None:
            try:
                with open(self._path, "r", encoding="utf-8") as f:
                    self._cache = json.load(f)
            except FileNotFoundError:
                self._cache = {}
        return self._cache

    def _save(self) -> None:
        os.makedirs(os.path.dirname(self._path) or ".", exist_ok=True)
        with open(self._path, "w", encoding="utf-8") as f:
            json.dump(self._all(), f, indent=2)

    def get(self, service_did: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            return self._all().get(service_did)

    def put(self, consent: Dict[str, Any]) -> None:
        with self._lock:
            self._all()[consent["serviceDid"]] = consent
            self._save()

    def drop(self, service_did: str) -> None:
        with self._lock:
            self._all().pop(service_did, None)
            self._save()
