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
 * The service the VP is bound to. The agent stamps this into every presentation
 * (`targetService`) and the MCP server is the audience. It is a plain string
 * identifier — not a URL — and does not need to be pre-registered for the
 * shipped verify + scope path this demo uses.
 */
export const TARGET_SERVICE = 'travel-booking-mcp';

/**
 * A demo user DID the agent claims to act on behalf of. In production this
 * comes from a real user-DID verification flow before the agent acts; here it
 * is a fixed placeholder so the happy path is deterministic.
 */
export const USER_DID = 'did:web:demo-traveler';

/**
 * The one persona enrolled at setup time, so the demo works immediately. It can
 * both search and book. Additional agents are enrolled at runtime from the web
 * UI by pasting a Console-generated onboarding token.
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

/** Encrypted wallet file for a given persona, on the shared volume. */
export function walletPathFor(personaId: string): string {
  return join(walletsDir, `${personaId}.enc`);
}

/** Config resolved from the environment, with container-friendly defaults. */
export const env = {
  /** Internal HelixID API URL (compose service DNS name inside the network). */
  helixApiUrl: process.env.HELIX_API_URL ?? 'http://helix-api:3000',
  /** Admin key used by Console and admin API surfaces; runtime onboarding consumes Console tokens. */
  adminApiKey: process.env.HELIX_ADMIN_API_KEY ?? 'dev-admin-key-change-in-production',
  /** Directory holding per-persona wallets + the persona manifest. */
  walletsDir,
  /** Manifest listing every enrolled persona (survives restarts on the volume). */
  personaManifestPath: join(walletsDir, 'personas.json'),
  walletPassphrase: process.env.WALLET_PASSPHRASE ?? 'demo-passphrase',
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
