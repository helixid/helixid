// The one place shared constants live. Everything else in this example is a
// single-responsibility file: the seeder enrolls, the MCP server verifies, the
// agent presents. If you find yourself hardcoding a scope or a service name in
// one of those, put it here instead.
import { join } from 'node:path';

/**
 * The demo maps travel actions onto already-shipped HelixID scopes. HelixID's
 * current privilege-scope allow-list is commerce-oriented, so — like v1 —
 * "search flights" is `read:catalog` and "book a flight" is `write:orders`.
 */
export const SCOPES = {
  /** Flight search — required by the search_flights tool. */
  FLIGHTS_READ: 'read:catalog',
  /** Flight booking — required by the book_flight tool. */
  FLIGHTS_BOOK: 'write:orders',
} as const;

/** The two protected MCP tools, each gated by one scope. */
export const TOOLS = {
  BOOK: 'book_flight',
  SEARCH: 'search_flights',
} as const;

/** Back-compat alias — the primary protected tool. */
export const PROTECTED_TOOL = TOOLS.BOOK;

/**
 * The Service Provider the MCP server plays. It is enrolled once as a service
 * on HelixID (self custody: Helix hosts its did:web, the service keeps its own
 * key in the shared volume). Every request proof names its DID as the audience
 * and every hop names it as the target.
 */
export const SERVICE_NAME = 'Helix Air (travel concierge)';

/**
 * The one persona enrolled at setup time, so the demo works immediately. It is
 * attested for both scopes and its responsible party gives it both at the
 * service. Additional agents are enrolled at runtime from the web UI by pasting
 * a Console-generated enrollment token.
 */
export const INITIAL_PERSONA = {
  id: 'concierge',
  displayName: 'Concierge Agent',
  scopes: [SCOPES.FLIGHTS_READ, SCOPES.FLIGHTS_BOOK],
} as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const walletsDir = process.env.WALLETS_DIR ?? '/wallets';

/**
 * A persona's own key directory on the shared volume: `helix init` writes its
 * DID document, card, summary and `signing-key.env` there. Self custody: the
 * key never leaves this directory, and the browser never sees it.
 */
export function keyDirFor(personaId: string): string {
  return join(walletsDir, personaId);
}

/** Config resolved from the environment, with container-friendly defaults. */
export const env = {
  /** Internal HelixID API URL (compose service DNS name inside the network). */
  helixApiUrl: process.env.HELIX_API_URL ?? 'http://helix-api:3000',
  /** Admin key: creates agents and the service, issues root hops and revokes (the organization's operator credential). */
  adminApiKey: process.env.HELIX_ADMIN_API_KEY ?? 'dev-admin-key-change-in-production',
  /** Directory holding the per-persona key directories, the persona manifest and the service's identity. */
  walletsDir,
  /** Manifest listing every enrolled persona (survives restarts on the volume). */
  personaManifestPath: join(walletsDir, 'personas.json'),
  /** The MCP service's DID and its own key (mode 0600). */
  serviceIdentityPath: join(walletsDir, 'mcp-service.json'),
  /** MCP server URL the agent connects to. */
  mcpServerUrl: process.env.MCP_SERVER_URL ?? 'http://mcp-server:7100/mcp',
  /** Ports. */
  mcpPort: Number(process.env.MCP_PORT ?? 7100),
  agentPort: Number(process.env.AGENT_PORT ?? 4000),
  /** LLM provider selection. */
  llmProvider: (process.env.LLM_PROVIDER ?? 'anthropic') as 'anthropic' | 'openai' | 'azure' | 'gemini',
  llmApiKeyOrThrow: (): string => required('LLM_API_KEY'),
  /** Optional model override — currently only read by the Gemini provider. */
  llmModel: process.env.LLM_MODEL || undefined,
  /**
   * Azure OpenAI settings — used only when LLM_PROVIDER=azure. LLM_API_KEY is
   * the Azure resource key; the "model" is your chat deployment name.
   */
  azureOpenAI: {
    endpointOrThrow: (): string => required('AZURE_OPENAI_ENDPOINT'),
    deploymentOrThrow: (): string => required('AZURE_OPENAI_DEPLOYMENT'),
    apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-21',
  },
};
