# The one place this app talks to the self-hosted HelixID API's admin
# surface. In OSS every privileged route (onboarding tokens, signing a VP for
# a server-held agent key, delegation, revocation, service enrollment and
# consent grants) is gated by the single admin key -- there are no accounts.
# The browser never sees this key; only the agent and MCP server processes
# hold it.

from __future__ import annotations

import re
import time
from typing import Any, Dict, Optional

import requests

from config import env


def patient_request(method: str, url: str, **kwargs: Any) -> requests.Response:
    """requests that waits out the API's rate limit instead of failing:
    running several scenarios back to back can burst past a per-minute cap.
    Honours Retry-After (or the "retry in N seconds" message), up to twice."""
    kwargs.setdefault("timeout", 20)
    attempt = 0
    while True:
        response = requests.request(method, url, **kwargs)
        if response.status_code != 429 or attempt >= 2:
            return response
        attempt += 1
        header = response.headers.get("retry-after")
        match = re.search(r"retry in (\d+)", response.text or "")
        wait = int(header) if header and header.isdigit() else int(match.group(1)) if match else 5
        wait = min(65, max(1, wait))
        print(f"[HelixID] rate limited on {url}; retrying in {wait}s", flush=True)
        time.sleep(wait)


def admin_call(path: str, body: Any = None, method: str = "POST") -> Dict[str, Any]:
    """One admin-authenticated call. Never raises on a 4xx -- refusals are data here: {"ok", "status", "body"}."""
    response = patient_request(
        method,
        f"{env.helix_api_url}{path}",
        headers={"x-admin-api-key": env.admin_api_key},
        **({"json": body} if body is not None else {}),
    )
    try:
        parsed = response.json()
    except ValueError:
        parsed = {}
    return {"ok": response.ok, "status": response.status_code, "body": parsed if isinstance(parsed, dict) else {}}


def describe_api_error(error: Optional[Dict[str, Any]], status: int) -> str:
    return (error or {}).get("message") or f"HTTP {status}"
