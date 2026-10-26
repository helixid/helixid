# Thin MCP client, Python port of ../e2e-travel-concierge/agent/mcpClient.ts.
# The agent is a real MCP client talking to the real MCP server over
# Streamable HTTP, via the official `mcp` package. One fresh client per call
# keeps it simple against the stateless server -- Flask is synchronous, so
# each call spins up its own asyncio event loop for the duration of one
# request/response round trip.

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Dict, Optional

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from config import env


@dataclass
class McpToolResult:
    is_error: bool
    text: str
    structured: Optional[Dict[str, Any]] = None


async def _call_mcp_tool_async(
    name: str, args: Dict[str, Any], meta: Optional[Dict[str, Any]] = None
) -> McpToolResult:
    async with streamablehttp_client(f"{env.mcp_base_url}/mcp") as (read, write, _get_session_id):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(name, args, meta=meta)
            text = "\n".join(c.text for c in result.content if c.type == "text")
            return McpToolResult(
                is_error=bool(result.isError),
                text=text,
                structured=result.structuredContent,
            )


def call_mcp_tool(name: str, args: Dict[str, Any], meta: Optional[Dict[str, Any]] = None) -> McpToolResult:
    return asyncio.run(_call_mcp_tool_async(name, args, meta))
