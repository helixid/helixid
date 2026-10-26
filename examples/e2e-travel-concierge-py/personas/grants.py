# Local index of the consent grants this demo asked a service to issue, so the
# UI can show "Ada -> Concierge at Helix Stay [read:catalog]" and offer a revoke
# button. The platform holds the grants themselves and is what sign_vp() picks
# them from; this file only remembers which grant id belongs to which
# (persona, traveler, service).

from __future__ import annotations

import json
import os
import threading
from typing import Any, Dict, List, Optional

from config import env

_lock = threading.Lock()


def _read_index() -> List[Dict[str, Any]]:
    try:
        with open(env.grant_index_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []
    grants = raw.get("grants") if isinstance(raw, dict) else None
    return list(grants) if isinstance(grants, list) else []


def _write_index(grants: List[Dict[str, Any]]) -> None:
    os.makedirs(os.path.dirname(env.grant_index_path), exist_ok=True)
    with open(env.grant_index_path, "w", encoding="utf-8") as f:
        json.dump({"grants": grants}, f, indent=2)
        f.write("\n")


def list_grants(persona_id: Optional[str] = None) -> List[Dict[str, Any]]:
    grants = _read_index()
    return [g for g in grants if g.get("personaId") == persona_id] if persona_id else grants


def add_grant(grant: Dict[str, Any]) -> None:
    with _lock:
        grants = _read_index()
        grants.append(grant)
        _write_index(grants)


def mark_grant_revoked(grant_id: str, revoked_at: str) -> Optional[Dict[str, Any]]:
    with _lock:
        grants = _read_index()
        found = next((g for g in grants if g.get("id") == grant_id), None)
        if found is not None:
            found["revokedAt"] = revoked_at
            _write_index(grants)
        return found
