# The MCP server plays two Service Providers, Helix Air and Helix Stay. Each
# is enrolled once as a service on the self-hosted API (POST /v1/services,
# admin-gated): the platform mints its DID and holds its key, so this process
# never holds one. The self-hosted API has no "list my services" route, so the
# DIDs are remembered in the state volume and reused across restarts.

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from config import SERVICES, ServiceDefinition, env
from personas.platform import admin_call, describe_api_error


@dataclass(frozen=True)
class RegisteredService:
    definition: ServiceDefinition
    did: str

    @property
    def id(self) -> str:
        return self.definition.id

    @property
    def short_name(self) -> str:
        return self.definition.short_name

    @property
    def require_user_consent(self) -> bool:
        return self.definition.require_user_consent

    @property
    def tools(self):
        return self.definition.tools


class PlatformError(Exception):
    """A refusal from the platform, with the code intact so the demo can show it."""

    def __init__(self, code: str, status: int, message: str):
        super().__init__(message)
        self.code = code
        self.status = status
        self.message = message


def _api(method: str, path: str, body: Any = None) -> Dict[str, Any]:
    result = admin_call(path, body, method=method)
    if not result["ok"]:
        error = result["body"].get("error") or {}
        raise PlatformError(error.get("code") or f"HTTP_{result['status']}", result["status"], describe_api_error(error, result["status"]))
    return result["body"]


def _read_index() -> Dict[str, str]:
    try:
        with open(env.service_index_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        return raw if isinstance(raw, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _write_index(index: Dict[str, str]) -> None:
    os.makedirs(os.path.dirname(env.service_index_path), exist_ok=True)
    with open(env.service_index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2)
        f.write("\n")


_registered: Optional[Dict[str, RegisteredService]] = None


def ensure_services() -> Dict[str, RegisteredService]:
    """Enrolls any demo service not enrolled yet; returns all of them with their DIDs."""
    global _registered
    if _registered:
        return _registered
    index = _read_index()
    result: Dict[str, RegisteredService] = {}
    for definition in SERVICES.values():
        did = index.get(definition.id)
        if not did:
            enrolled = _api(
                "POST",
                "/v1/services",
                {
                    # Service names are unique on a self-hosted server; the suffix keeps a
                    # re-enrollment (state volume lost, database kept) from colliding.
                    "name": f"{definition.name} {int(time.time()):x}",
                    "domain": definition.domain,
                    "requiredScopes": sorted({tool.required_scope for tool in definition.tools}),
                    "framework": "flask",
                },
            )
            did = enrolled["did"]
            index[definition.id] = did
            _write_index(index)
        result[definition.id] = RegisteredService(definition=definition, did=did)
    _registered = result
    return result


def issue_consent_grant(service: RegisteredService, agent_did: str, user_did: str, scopes: List[str], durability: str) -> Dict[str, Any]:
    """Asks the platform to sign a consent grant with this service's key: the
    traveler `user_did` lets `agent_did` use `scopes` at this service. This is
    the SP's half of a consent screen -- the agent never signs its own consent."""
    grant_vc = _api(
        "POST",
        "/v1/service-delegation-grants",
        {"serviceDid": service.did, "agentDid": agent_did, "userDid": user_did, "scopes": scopes, "durability": durability},
    )["grantVC"]
    return {
        "id": grant_vc["id"],
        "validFrom": grant_vc.get("validFrom"),
        "validUntil": grant_vc.get("validUntil"),
        "scopes": (grant_vc.get("credentialSubject") or {}).get("scopes") or scopes,
    }
