// The agent's view of the two Service Providers: their platform-minted DIDs
// come from the MCP server's /services (the SP is the source of its own
// identity), fetched once and cached.
import { env, type ServiceId } from '../config.js';

export interface ServiceInfo {
  id: ServiceId;
  name: string;
  did: string;
  requireUserConsent: boolean;
  tools: { name: string; requiredScope: string }[];
}

let cached: ServiceInfo[] | null = null;

export async function listServices(): Promise<ServiceInfo[]> {
  if (cached) return cached;
  const res = await fetch(`${env.mcpBaseUrl}/services`);
  if (!res.ok) throw new Error(`MCP server /services failed: HTTP ${res.status} -- is \`pnpm run mcp\` running?`);
  cached = ((await res.json()) as { services: ServiceInfo[] }).services;
  return cached;
}

export async function getService(id: ServiceId): Promise<ServiceInfo> {
  const service = (await listServices()).find((entry) => entry.id === id);
  if (!service) throw new Error(`Unknown service: ${id}`);
  return service;
}
