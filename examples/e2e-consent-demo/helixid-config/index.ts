// Shared, compose-time configuration for the consent demo.
//
// Two independent Service Providers, each with its own did:web identity, its
// own status list, and its own grantable-scope catalog. Nothing is shared
// between them at runtime — that independence is the point of steps 3 and 4 of
// the demo flow.

import type { CuratedScopeEntry } from '@helixid/widget';

/** Scope strings. SP-owned — HelixID never invents these (register D8). */
export const SCOPES = {
  BOOK_FLIGHTS: 'book:flights',
  MODIFY_BOOKING: 'modify:booking',
  BOOK_HOTEL: 'book:hotel',
} as const;

/**
 * One demo tool. `requiredScope` is deliberately absent on the search tools:
 * they are open and read-only, so step 2 of the demo flow can never trigger a
 * consent prompt (register D7, closing Epic 5 Part G).
 */
export interface DemoTool {
  name: string;
  description: string;
  metadata?: { requiredScope?: string };
}

export interface SpDefinition {
  id: 'airline' | 'hotel';
  displayName: string;
  port: number;
  /** Scope catalog the consent widget offers for this SP (register D8). */
  curatedFallback: CuratedScopeEntry[];
  tools: DemoTool[];
}

export const AIRLINE: SpDefinition = {
  id: 'airline',
  displayName: 'Helix Air',
  port: Number(process.env['AIRLINE_PORT'] ?? 4101),
  curatedFallback: [
    { scope: SCOPES.BOOK_FLIGHTS, label: 'Book flights', description: 'Purchase flights on your behalf' },
    {
      scope: SCOPES.MODIFY_BOOKING,
      label: 'Modify bookings',
      description: 'Change or cancel an existing flight booking',
    },
  ],
  tools: [
    // No requiredScope — open, read-only (register D7).
    {
      name: 'search_flights',
      description:
        'Search available flights for a route and date. Optionally narrow by carrier and party size. Open, no grant required.',
    },
    {
      name: 'book_flight',
      description: 'Book a flight. Requires a consent grant carrying book:flights.',
      metadata: { requiredScope: SCOPES.BOOK_FLIGHTS },
    },
    {
      name: 'modify_booking',
      description: 'Modify an existing booking. Requires a consent grant carrying modify:booking.',
      metadata: { requiredScope: SCOPES.MODIFY_BOOKING },
    },
  ],
};

export const HOTEL: SpDefinition = {
  id: 'hotel',
  displayName: 'Helix Stay',
  port: Number(process.env['HOTEL_PORT'] ?? 4102),
  curatedFallback: [
    { scope: SCOPES.BOOK_HOTEL, label: 'Book hotels', description: 'Reserve hotel rooms on your behalf' },
  ],
  tools: [
    // No requiredScope — open, read-only (register D7).
    {
      name: 'search_hotels',
      description:
        'Search available hotels in a city. Optionally cap the nightly rate. Open, no grant required.',
    },
    {
      name: 'book_hotel',
      description: 'Book a hotel room. Requires a consent grant carrying book:hotel.',
      metadata: { requiredScope: SCOPES.BOOK_HOTEL },
    },
  ],
};

export const SPS: SpDefinition[] = [AIRLINE, HOTEL];

/**
 * did:web for a locally-hosted SP. The percent-encoded port is the form
 * helix-core's resolver maps to `http://<host>:<port>/.well-known/did.json`,
 * so DID resolution works across the compose network without TLS.
 */
export function spDidFor(host: string, port: number): string {
  return `did:web:${encodeURIComponent(`${host}:${port}`)}`;
}

export function spBaseUrlFor(host: string, port: number): string {
  return `http://${host}:${port}`;
}

/** Public URL of an SP's status list — what lands in every grant's credentialStatus. */
export function statusListUrlFor(baseUrl: string): string {
  return `${baseUrl}/status-list/1`;
}

/**
 * The agent's own authority ceiling, issued by the platform operator at
 * enrollment. A consent grant never widens this: verification intersects the
 * two (`effectiveScopes`), so the agent VC is the upper bound and the grant is
 * the user's per-SP consent within it.
 */
export const AGENT_PRIVILEGE_SCOPES: string[] = [
  SCOPES.BOOK_FLIGHTS,
  SCOPES.MODIFY_BOOKING,
  SCOPES.BOOK_HOTEL,
];

/**
 * The End User identifier. A DID here; a plain email string is the accepted
 * fallback and matches identically (plain string equality at verification).
 * Whichever form is used at consent time must be the same form the agent puts
 * in the VP's `delegatedBy`, or the user-match fails.
 */
export const DEMO_USER_DID = 'did:web:traveler.example';

/**
 * The agent's onboarding result, as recorded by the seeder.
 *
 * Agent self-custody is retired: onboarding returns only { agentDid, vcId }
 * and the private key never leaves the server, so there is no wallet file
 * whose existence used to imply the agent's DID. The seeder writes this file
 * instead, and the agent server reads it on boot.
 */
export interface AgentIdentity {
  agentDid: string;
  vcId: string;
}

export function agentIdentityPath(walletsDir: string, agentId: string): string {
  return `${walletsDir}/${agentId}.agent.json`;
}

export const env = {
  host: process.env['DEMO_HOST'] ?? 'localhost',
  helixApiUrl: process.env['HELIX_API_URL'] ?? 'http://helix-api:3000',
  adminApiKey: process.env['HELIX_ADMIN_API_KEY'] ?? 'dev-admin-key-change-in-production',
  walletsDir: process.env['WALLETS_DIR'] ?? '/wallets',
  walletPassphrase: process.env['WALLET_PASSPHRASE'] ?? 'demo-passphrase',
  agentPort: Number(process.env['AGENT_PORT'] ?? 4100),
  airlineUrl: process.env['AIRLINE_URL'] ?? `http://${process.env['DEMO_HOST'] ?? 'localhost'}:${AIRLINE.port}`,
  hotelUrl: process.env['HOTEL_URL'] ?? `http://${process.env['DEMO_HOST'] ?? 'localhost'}:${HOTEL.port}`,
  llmProvider: (process.env['LLM_PROVIDER'] ?? 'gemini') as 'gemini' | 'openai' | 'anthropic',
  llmApiKey:
    process.env['LLM_API_KEY'] ??
    process.env['GEMINI_API_KEY'] ??
    process.env['OPENAI_API_KEY'] ??
    process.env['ANTHROPIC_API_KEY'] ??
    '',
  llmModel: process.env['LLM_MODEL'] ?? '',
  consoleUrl: process.env['CONSOLE_URL'] ?? 'http://localhost:8080',
};
