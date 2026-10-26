# The agent's view of the Service Providers: their platform-minted DIDs come
# from the MCP server's /services (the SP is the source of its own identity),
# fetched once and cached.

from __future__ import annotations

from typing import Any, Dict, List, Optional

import requests

from config import env

_cached: Optional[List[Dict[str, Any]]] = None


def list_services() -> List[Dict[str, Any]]:
    global _cached
    if _cached:
        return _cached
    response = requests.get(f"{env.mcp_base_url}/services", timeout=15)
    if not response.ok:
        raise RuntimeError(f"MCP server /services failed: HTTP {response.status_code} -- is `python -m mcp_server.server` running?")
    _cached = response.json()["services"]
    return _cached


def get_service(service_id: str) -> Dict[str, Any]:
    service = next((s for s in list_services() if s["id"] == service_id), None)
    if service is None:
        raise RuntimeError(f"Unknown service: {service_id}")
    return service
