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

/** The protected MCP tools: flights at Helix Air, hotels at Helix Stay. */
export const TOOLS = {
  BOOK: 'book_flight',
  SEARCH: 'search_flights',
  SEARCH_HOTELS: 'search_hotels',
  BOOK_HOTEL: 'book_hotel',
} as const;

export type ServiceId = 'air' | 'stay';

export interface ServiceDefinition {
  id: ServiceId;
  /** Enrolled under this name, so a restart finds the same service (and DID) again. */
  name: string;
  domain: string;
  /**
   * Helix Stay only books on behalf of a traveler who consented: a VP that
   * names no user is refused with CONSENT_REQUIRED. Helix Air also accepts
   * an agent acting on its own organization-issued authority.
   */
  requireUserConsent: boolean;
  tools: { name: string; requiredScope: string }[];
}

/**
 * The two Service Providers the MCP server plays. Each is enrolled as a
 * service on the platform (POST /v1/services), which mints its
 * did:web and holds its key -- VPs are bound to that DID (`targetService`)
 * and consent grants for it are signed with it.
 */
export const SERVICES: Record<ServiceId, ServiceDefinition> = {
  air: {
    id: 'air',
    name: 'Helix Air (travel concierge demo)',
    domain: 'air.concierge-demo.example',
    requireUserConsent: false,
    tools: [
      { name: TOOLS.SEARCH, requiredScope: SCOPES.FLIGHTS_READ },
      { name: TOOLS.BOOK, requiredScope: SCOPES.FLIGHTS_BOOK },
    ],
  },
  stay: {
    id: 'stay',
    name: 'Helix Stay (travel concierge demo)',
    domain: 'stay.concierge-demo.example',
    requireUserConsent: true,
    tools: [
      { name: TOOLS.SEARCH_HOTELS, requiredScope: SCOPES.FLIGHTS_READ },
      { name: TOOLS.BOOK_HOTEL, requiredScope: SCOPES.FLIGHTS_BOOK },
    ],
  },
};

/** Which service each tool belongs to. */
export function serviceForTool(toolName: string): ServiceDefinition | undefined {
  return Object.values(SERVICES).find((service) => service.tools.some((tool) => tool.name === toolName));
}

/**
 * Demo travelers an agent can act on behalf of. A consent grant records the
 * user as `credentialSubject.userDid`; in production that DID comes from a
 * real sign-in, here it is fixed so the scenarios are deterministic.
 */
export const USERS = {
  ada: { id: 'ada', name: 'Ada Lovelace', did: 'did:example:traveler:ada-lovelace' },
  grace: { id: 'grace', name: 'Grace Hopper', did: 'did:example:traveler:grace-hopper' },
} as const;

export type UserId = keyof typeof USERS;

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

/** Shared volume for this app's local state (persona manifest, grant index, service DIDs). */
const stateDir = process.env.STATE_DIR ?? process.env.WALLETS_DIR ?? '/wallets';

/** Encrypted wallet file for a given persona, on the shared volume. */

/** Config resolved from the environment, with container-friendly defaults. */
export const env = {
  /** Internal HelixID API URL (compose service DNS name inside the network). */
  helixApiUrl: process.env.HELIX_API_URL ?? 'http://helix-api:3000',
  /** Admin key used by Console and admin API surfaces; runtime onboarding consumes Console tokens. */
  adminApiKey: process.env.HELIX_ADMIN_API_KEY ?? 'dev-admin-key-change-in-production',
  /** Manifest listing every enrolled persona (survives restarts on the volume). */
  personaManifestPath: join(stateDir, 'personas.json'),
  /** Local index of consent grants issued through this demo (the platform holds the grants themselves). */
  grantIndexPath: join(stateDir, 'grants.json'),
  /**
   * The DIDs of the two demo services, once enrolled. The self-hosted API
   * has no "list my services" route, so the MCP server remembers them here.
   */
  serviceIndexPath: join(stateDir, 'services.json'),
  /** MCP server base URL; each service is served at <base>/mcp/<serviceId>. */
  mcpBaseUrl: (process.env.MCP_BASE_URL ?? 'http://mcp-server:7100').replace(/\/+$/, ''),
  /** Ports. */
  mcpPort: Number(process.env.MCP_PORT ?? 7100),
  agentPort: Number(process.env.AGENT_PORT ?? 4000),
  /** LLM provider selection. */
  llmProvider: (process.env.LLM_PROVIDER ?? 'anthropic') as 'anthropic' | 'openai' | 'azure' | 'gemini',
  llmApiKeyOrThrow: () => required('LLM_API_KEY'),
  /** Optional model override — currently only read by the Gemini provider. */
  llmModel: process.env.LLM_MODEL || undefined,
  /**
   * Azure OpenAI settings — used only when LLM_PROVIDER=azure. LLM_API_KEY is
   * the Azure resource key; the "model" is your chat deployment name.
   */
  azureOpenAI: {
    endpointOrThrow: () => required('AZURE_OPENAI_ENDPOINT'),
    deploymentOrThrow: () => required('AZURE_OPENAI_DEPLOYMENT'),
    apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-21',
  },
};
