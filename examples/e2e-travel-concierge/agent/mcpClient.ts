// Thin MCP client. The agent is a real MCP client talking to the real MCP server
// over Streamable HTTP. One fresh client per call keeps it simple against the
// stateless server.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { env } from '../config.js';

export interface McpToolResult {
  isError: boolean;
  text: string;
  structured?: unknown;
}

export async function callMcpTool(
  serviceId: string,
  name: string,
  args: Record<string, unknown>,
  meta?: Record<string, unknown>,
): Promise<McpToolResult> {
  const transport = new StreamableHTTPClientTransport(new URL(`${env.mcpBaseUrl}/mcp/${serviceId}`));
  const client = new Client({ name: 'travel-concierge-agent', version: '0.1.0' });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    return { isError: result.isError === true, text, structured: result.structuredContent };
  } finally {
    await client.close();
  }
}
