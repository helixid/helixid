# Manifest-backed persona registry, Python port of ../personas/store.ts. The
# manifest lives on the shared volume as personas.json -- the same
# file the still-JS helixid-setup seeder writes the initial Concierge persona
# to -- so personas enrolled at runtime (by either process) survive restarts
# and are visible to a freshly-booted agent. Held in memory for fast reads.

from __future__ import annotations

import json
import os
import threading
from typing import Dict, List, Optional

from config import env
from personas.types import Persona

_personas: Optional[Dict[str, Persona]] = None
_lock = threading.Lock()


def _read_manifest() -> List[Persona]:
    try:
        with open(env.persona_manifest_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []
    entries = raw.get("personas") if isinstance(raw, dict) else None
    if not isinstance(entries, list):
        return []
    return [Persona.from_dict(p) for p in entries]


def _write_manifest(personas: List[Persona]) -> None:
    os.makedirs(os.path.dirname(env.persona_manifest_path), exist_ok=True)
    payload = {"personas": [p.to_dict() for p in personas]}
    with open(env.persona_manifest_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")


def load_personas() -> None:
    """Load the manifest into memory. Call once at process start."""
    global _personas
    with _lock:
        _personas = {p.id: p for p in _read_manifest()}


def _ensure_loaded() -> Dict[str, Persona]:
    if _personas is None:
        raise RuntimeError("Persona registry not loaded -- call load_personas() first.")
    return _personas


def list_personas() -> List[dict]:
    return [p.to_public() for p in _ensure_loaded().values()]


def get_persona(persona_id: str) -> Optional[Persona]:
    return _ensure_loaded().get(persona_id)


def has_persona(persona_id: str) -> bool:
    return persona_id in _ensure_loaded()


def add_persona(persona: Persona) -> None:
    """Adds a persona and persists. Re-reads the manifest first and merges,
    so an entry written by the other process (seeder vs. agent) is never
    clobbered."""
    global _personas
    with _lock:
        on_disk = {p.id: p for p in _read_manifest()}
        on_disk[persona.id] = persona
        _write_manifest(list(on_disk.values()))
        _personas = on_disk


def update_persona(
    persona_id: str,
    *,
    scopes: Optional[List[str]] = None,
    active_credential_id: Optional[str] = None,
    delegated_from_persona_id: Optional[str] = None,
    delegated_scopes: Optional[List[str]] = None,
    _clear_delegation: bool = False,
) -> Persona:
    global _personas
    with _lock:
        on_disk = {p.id: p for p in _read_manifest()}
        current = on_disk.get(persona_id)
        if current is None:
            raise RuntimeError(f"Unknown persona: {persona_id}")
        if scopes is not None:
            current.scopes = scopes
        if active_credential_id is not None:
            current.active_credential_id = active_credential_id
        if _clear_delegation:
            current.delegated_from_persona_id = None
            current.delegated_scopes = None
        else:
            if delegated_from_persona_id is not None:
                current.delegated_from_persona_id = delegated_from_persona_id
            if delegated_scopes is not None:
                current.delegated_scopes = delegated_scopes
        on_disk[persona_id] = current
        _write_manifest(list(on_disk.values()))
        _personas = on_disk
        return current
