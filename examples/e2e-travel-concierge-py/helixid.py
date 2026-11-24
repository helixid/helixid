# The two kinds of call this example makes to HelixID, Python port of
# ../e2e-travel-concierge/helixid.ts: admin calls (the organization's operator
# credential: create agents and the service, issue root hops, revoke) and
# fetching the did:web documents, cards and status lists HelixID serves.

from __future__ import annotations

import re
from typing import Any, Optional
from urllib.parse import urlparse

import requests

from config import env


class HelixRefusal(Exception):
    def __init__(self, code: str, status: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def admin(method: str, path: str, body: Optional[Any] = None) -> Any:
    res = requests.request(
        method,
        f"{env.helix_api_url}{path}",
        headers={"x-admin-api-key": env.admin_api_key},
        json=body,
        timeout=30,
    )
    try:
        parsed = res.json()
    except ValueError:
        parsed = {}
    if not res.ok:
        error = (parsed or {}).get("error") if isinstance(parsed, dict) else None
        error = error if isinstance(error, dict) else {}
        raise HelixRefusal(error.get("code") or f"HTTP_{res.status_code}", res.status_code, error.get("message") or f"{method} {path} failed: HTTP {res.status_code}")
    return parsed


_HELIX_HOST = urlparse(env.helix_api_url).netloc
_HTTPS_HELIX = re.compile(rf"^https://{re.escape(_HELIX_HOST)}(?=[/?#]|$)")


def helix_url(url: str) -> str:
    """A did:web names HelixID's documents over https; on a local or compose
    network (http) the https URL of HelixID's own host is fetched over http."""
    return _HTTPS_HELIX.sub(f"http://{_HELIX_HOST}", url)


def helix_fetch_json(url: str) -> Any:
    res = requests.get(helix_url(url), timeout=15)
    res.raise_for_status()
    return res.json()
