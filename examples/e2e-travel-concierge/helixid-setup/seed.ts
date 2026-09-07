// helixid-setup — the run-once seeder.
//
// Mental model: this is a migration, not a service. It runs, enrolls the initial
// Concierge agent against the live HelixID API, records it in the persona
// manifest on the shared volume, and exits 0 so docker-compose starts the MCP
// server and agent that depend on it.
//
// A second, booking-restricted "Search Agent" is intentionally NOT seeded here —
// it is enrolled later, at runtime, through the agent's admin onboarding route,
// which is what demonstrates live enrollment.
//
// Everything here is a real API call. The enrollment token is minted through the
// live endpoint; the credential is issued by the live issuer. Nothing is stubbed.
import 'dotenv/config';
import { INITIAL_PERSONA, env } from '../config.js';
import { enrollPersona } from '../personas/enroll.js';
import { addPersona, hasPersona, loadPersonas } from '../personas/store.js';

function log(actor: 'Setup' | 'Agent Owner' | 'Helix ID' | 'Agent', message: string): void {
  console.log(`[${actor}] ${message}`);
}

async function waitForApi(url: string, attempts = 60): Promise<void> {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) {
        log('Setup', `HelixID API is healthy at ${url}.`);
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`HelixID API at ${url} did not become healthy in time.`);
}

// This seed is shared with e2e-travel-concierge-py, whose Console is published
// on a different port, so the URL printed below is overridable.
const CONSOLE_URL = process.env.CONSOLE_URL ?? 'http://localhost:8080';

async function main(): Promise<void> {
  await waitForApi(env.helixApiUrl);
  await loadPersonas();

  // Re-running the demo should not re-enroll. (docker-compose down -v is the
  // reset path — documented in the README.)
  if (hasPersona(INITIAL_PERSONA.id)) {
    log('Setup', `Persona "${INITIAL_PERSONA.id}" already enrolled; skipping.`);
    log('Setup', `Seed complete (reused). Open Console at ${CONSOLE_URL} → Audit.`);
    return;
  }

  log('Agent Owner', `Enrolling initial persona "${INITIAL_PERSONA.displayName}" (${INITIAL_PERSONA.scopes.join(', ')}).`);
  const { persona, vcId, did } = await enrollPersona({
    id: INITIAL_PERSONA.id,
    displayName: INITIAL_PERSONA.displayName,
    scopes: [...INITIAL_PERSONA.scopes],
  });
  await addPersona(persona);

  log('Helix ID', `Issued credential ${vcId}.`);
  log('Agent', `DID: ${did}`);
  log('Agent', `Scopes: ${persona.scopes.join(', ')}`);
  log('Agent', `Encrypted wallet written to ${persona.walletFile}.`);
  log('Setup', `Seed complete. Token, enrollment and issuance events are now in Console → Audit (${CONSOLE_URL}).`);
}

main().catch((error: unknown) => {
  console.error('[Setup] Seeding failed:', error);
  process.exit(1);
});
