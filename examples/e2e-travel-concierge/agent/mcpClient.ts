// The agent's MCP tools/call: JSON-RPC over HTTP to the MCP server, sent as
// built. The request proof covers the call exactly as sent, so no client
// library rewrites it on the way.
import { env } from '../config.js';

export interface McpCall {
  method: string;
  params: Record<string, unknown>;
}

export interface McpToolResult {
  isError: boolean;
  text: string;
  structured?: Record<string, unknown>;
}

export async function sendMcpCall(call: McpCall): Promise<McpToolResult> {
  const res = await fetch(env.mcpServerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...call }),
  });
  const body = (await res.json().catch(() => ({}))) as { result?: Record<string, unknown>; error?: { message?: string } };
  if (!body.result) return { isError: true, text: body.error?.message ?? `MCP call failed: HTTP ${res.status}` };
  const content = Array.isArray(body.result['content']) ? (body.result['content'] as { type?: string; text?: string }[]) : [];
  return {
    isError: body.result['isError'] === true,
    text: content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n'),
    ...(body.result['structuredContent'] !== undefined ? { structured: body.result['structuredContent'] as Record<string, unknown> } : {}),
  };
}
