# The agent's MCP tools/call, Python port of
# ../../e2e-travel-concierge/agent/mcpClient.ts: JSON-RPC over HTTP to the MCP
# server, sent as built. The request proof covers the call exactly as sent, so
# no client library rewrites it on the way.

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional

import requests

from config import env


@dataclass
class McpToolResult:
    is_error: bool
    text: str
    structured: Optional[Dict[str, Any]] = None


def send_mcp_call(call: Mapping[str, Any]) -> McpToolResult:
    res = requests.post(
        env.mcp_server_url,
        json={"jsonrpc": "2.0", "id": 1, **call},
        headers={"accept": "application/json, text/event-stream"},
        timeout=60,
    )
    try:
        body = res.json()
    except ValueError:
        body = {}
    result = body.get("result") if isinstance(body, dict) else None
    if not isinstance(result, dict):
        message = ((body or {}).get("error") or {}).get("message") if isinstance(body, dict) else None
        return McpToolResult(is_error=True, text=message or f"MCP call failed: HTTP {res.status_code}")
    text = "\n".join(c.get("text", "") for c in result.get("content") or [] if c.get("type") == "text")
    return McpToolResult(is_error=result.get("isError") is True, text=text, structured=result.get("structuredContent"))
