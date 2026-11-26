// Shared, compose-time configuration for the consent demo.
//
// Two independent Service Providers, each enrolled as its own service on the
// platform (its own did:web, its own key) with its own scope catalog. A user's
// consent at one never covers the other: each is the root of a chain signed by
// the user's pairwise did:key at that service (KYA-OS story L3-H). Nothing is shared between them at runtime — that independence is
// the point of steps 3 and 4 of the demo flow.
//
// helixid is self-custody only: the SPs and the agent each generate their own
// key locally and send Helix only the public key (seed/seed.ts).

/** One scope an SP can ask a user to consent to, as the consent page shows it. */
export interface CuratedScopeEntry {
  scope: string;
  label: string;
  description: string;
}

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
  /**
   * Every scope this SP can ask consent for (its catalog). Helix refuses a
   * consent request for a scope the agent is not attested for, so what the
   * user is asked is this catalog ∩ the agent's own scopes.
   */
  scopeCatalog: CuratedScopeEntry[];
  tools: DemoTool[];
}

export const AIRLINE: SpDefinition = {
  id: 'airline',
  displayName: 'Helix Air',
  port: Number(process.env['AIRLINE_PORT'] ?? 4101),
  scopeCatalog: [
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
        'Search available flights for a route and date. Optionally narrow by carrier and party size. Open, no consent required.',
    },
    {
      name: 'book_flight',
      description: 'Book a flight. Requires the user consent for book:flights.',
      metadata: { requiredScope: SCOPES.BOOK_FLIGHTS },
    },
    {
      name: 'modify_booking',
      description: 'Modify an existing booking. Requires the user consent for modify:booking.',
      metadata: { requiredScope: SCOPES.MODIFY_BOOKING },
    },
  ],
};

export const HOTEL: SpDefinition = {
  id: 'hotel',
  displayName: 'Helix Stay',
  port: Number(process.env['HOTEL_PORT'] ?? 4102),
  scopeCatalog: [
    { scope: SCOPES.BOOK_HOTEL, label: 'Book hotels', description: 'Reserve hotel rooms on your behalf' },
  ],
  tools: [
    // No requiredScope — open, read-only (register D7).
    {
      name: 'search_hotels',
      description:
        'Search available hotels in a city. Optionally cap the nightly rate. Open, no consent required.',
    },
    {
      name: 'book_hotel',
      description: 'Book a hotel room. Requires the user consent for book:hotel.',
      metadata: { requiredScope: SCOPES.BOOK_HOTEL },
    },
  ],
};

export const SPS: SpDefinition[] = [AIRLINE, HOTEL];

/**
 * The agent's own authority ceiling, issued by the platform operator at
 * enrollment. The user's consent never widens this: the consent screen offers
 * only these scopes ∩ the SP's catalog, and verification intersects the chain
 * with them (`effectiveScopes`), so the agent VC is the upper bound and the
 * root hop the user signed is the per-SP consent within it.
 */
export const AGENT_PRIVILEGE_SCOPES: string[] = [
  SCOPES.BOOK_FLIGHTS,
  SCOPES.MODIFY_BOOKING,
  SCOPES.BOOK_HOTEL,
];

/**
 * The traveler's account at both SPs ("ada"). KYA-OS story L3-H: a user is
 * known to Helix only as a pairwise did:key per (service, this id), created on
 * the user's first consent and held by Helix; the id itself is never stored.
 * The agent names the account it acts for in each call's `_meta` (a demo
 * simplification: a production SP takes it from its own session or OAuth).
 */
export const DEMO_SERVICE_USER = 'ada';

export const env = {
  host: process.env['DEMO_HOST'] ?? 'localhost',
  /** The HelixID API. Docker Compose shares its network with it (localhost:3000). */
  helixApiUrl: (process.env['HELIX_API_URL'] ?? 'http://localhost:3000').replace(/\/+$/, ''),
  /** The operator's admin key: the seeder enrolls both SPs and the agent with it. */
  adminApiKey: process.env['HELIX_ADMIN_API_KEY'] ?? 'dev-admin-key-change-in-production',
  /** Identity directory: each SP's DID with its own signing key, the agent's
   * DID with its own signing key, and the agent's consent hops (demo only: keep
   * real keys in a secret store or KMS). */
  walletsDir: process.env['WALLETS_DIR'] ?? new URL('../.data/wallets', import.meta.url).pathname,
  agentPort: Number(process.env['AGENT_PORT'] ?? 4100),
  /** How long a user's consent lasts (default 30 days), and each hop inside it (default 1 h, renewed without a click). */
  consentWindowSeconds: Number(process.env['CONSENT_WINDOW_SECONDS'] ?? 30 * 24 * 3600),
  consentHopLifetimeSeconds: Number(process.env['CONSENT_HOP_LIFETIME_SECONDS'] ?? 3600),
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

/** Local runs against a loopback API read DID documents, cards and status lists over http. */
export const allowLoopbackHttp = /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(env.helixApiUrl);

/** Where the seeder writes the agent's identity: its DID, kid, and signing-key.env (helix init's output). */
export function agentDir(walletsDir: string): string {
  return `${walletsDir}/travel-planner`;
}
