// e2e-consent-demo seeder (Epic 5 Part A).
//
// Run-once migration, not a service. It:
//   1. provisions a did:web DID for each demo SP, generating and hosting each
//      SP's initial status list in the same step (Epic 1 A5's onboarding shape);
//   2. onboards the Travel Planner Agent against the live HelixID API;
//   3. prints agent DID, both SP DIDs, both status-list URLs, and Console URL.
//
// There is no POST /v1/services call anywhere in this path — the service
// registry was removed in Epic 1. An SP's identity is its DID, and the only
// legitimacy check a verifier needs is resolving that DID and checking the
// signature on what it issued.

import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { HelixClient } from '@helixid/sdk-js';
import {
  AGENT_PRIVILEGE_SCOPES,
  DEMO_USER_DID,
  SPS,
  agentIdentityPath,
  env,
  type AgentIdentity,
} from '../helixid-config/index.js';
import { provisionSpIdentity, statePath } from '../sp-shared/identity.js';

const AGENT_ID = 'travel-planner';

function log(actor: 'Setup' | 'SP' | 'Helix ID' | 'Agent', message: string): void {
  console.log(`[${actor}] ${message}`);
}

/** The agent's recorded onboarding result, or null on a first run. */
async function readIdentity(path: string): Promise<AgentIdentity | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as AgentIdentity;
  } catch {
    return null;
  }
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
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`HelixID API at ${url} did not become healthy in time.`);
}

async function mintToken(displayName: string, scopes: string[]): Promise<string> {
  const res = await fetch(`${env.helixApiUrl}/v1/enrollment-tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agentName: displayName,
      requestedScopes: scopes,
      requestedDomains: [],
      maxDelegationDepth: 0,
    }),
  });
  const body = (await res.json()) as { token?: string };
  if (!res.ok || !body.token) {
    throw new Error(`Failed to mint enrollment token: HTTP ${res.status}`);
  }
  return body.token;
}

async function main(): Promise<void> {
  await mkdir(env.walletsDir, { recursive: true });

  // ── 1. SP identities: did:web + initial status list, together ───────────
  const provisioned: Array<{ id: string; did: string; statusListUrl: string }> = [];
  for (const sp of SPS) {
    const { identity, statusList, created } = await provisionSpIdentity({
      dir: env.walletsDir,
      spId: sp.id,
      host: env.host,
      port: sp.port,
    });

    if (created) {
      // Seed the SP's persisted state with the status list generated alongside
      // its DID, so the server hosts the same list the DID was provisioned with.
      await writeFile(
        statePath(env.walletsDir, sp.id),
        JSON.stringify({ statusList, grants: [] }, null, 2),
        'utf8',
      );
      log('SP', `Provisioned ${sp.displayName}: ${identity.did}`);
      log('SP', `  status list -> ${identity.statusListUrl}`);
    } else {
      log('SP', `${sp.displayName} already provisioned (${identity.did}); reusing.`);
    }

    provisioned.push({ id: sp.id, did: identity.did, statusListUrl: identity.statusListUrl });
  }

  // ── 2. Travel Planner Agent onboarding (server custody) ─────────────────
  await waitForApi(env.helixApiUrl);

  const identityFile = agentIdentityPath(env.walletsDir, AGENT_ID);
  let identity = await readIdentity(identityFile);

  if (identity) {
    log('Setup', `Agent "${AGENT_ID}" already onboarded; reusing ${identity.agentDid}.`);
  } else {
    const token = await mintToken('Travel Planner Agent', [...AGENT_PRIVILEGE_SCOPES]);
    const client = new HelixClient(env.helixApiUrl, { adminApiKey: env.adminApiKey });
    // Two calls on purpose: minting the enrollment token is the agent owner's
    // action, onboarding redeems it. Console does both in one step; a script
    // does them back to back. There is no wallet, passphrase or local key any
    // more — the server generates and holds the agent's key.
    identity = await client.onboardAgent(token, []);
    await writeFile(identityFile, JSON.stringify(identity, null, 2), 'utf8');
    log('Helix ID', `Onboarded agent ${identity.agentDid} (credential ${identity.vcId}).`);
  }

  const agentDid = identity.agentDid;

  // ── 3. Summary ──────────────────────────────────────────────────────────
  console.log('');
  log('Setup', 'Seed complete.');
  log('Agent', `Travel Planner DID : ${agentDid}`);
  log('Agent', `Authority scopes   : ${AGENT_PRIVILEGE_SCOPES.join(', ')}`);
  log('Agent', `End user           : ${DEMO_USER_DID}`);
  for (const sp of provisioned) {
    log('SP', `${sp.id} DID          : ${sp.did}`);
    log('SP', `${sp.id} status list  : ${sp.statusListUrl}`);
  }
  log('Setup', `Console            : ${env.consoleUrl}`);
}

main().catch((error: unknown) => {
  console.error('[Setup] Seeding failed:', error);
  process.exit(1);
});
