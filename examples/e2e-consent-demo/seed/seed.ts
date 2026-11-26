// e2e-consent-demo seeder. Run once, not a service. It:
//   1. enrolls each demo SP as a service at HelixID, self custody: the SP
//      generates its own Ed25519 key and sends only the public key; HelixID
//      hosts its did:web (sp-shared/identity.ts);
//   2. onboards the Travel Planner Agent, self custody: the operator creates
//      it (admin POST /v1/agents, keyCustody 'self'), and `helixInit`
//      generates the agent's key locally and enrolls it with the token. Helix
//      issues its identity credential and attests its scopes (its Entity
//      Card); the private key stays in the wallets directory;
//   3. prints the agent DID, both SP DIDs and the Console URL.
//
// A user's consent is not seeded: it is given on Helix's consent page, the
// first time an SP asks (KYA-OS story L3-H).

import 'dotenv/config';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { helixInit } from '@helixid/sdk-js';
import { AGENT_PRIVILEGE_SCOPES, SPS, agentDir, env } from '../helixid-config/index.js';
import { enrollSpService } from '../sp-shared/identity.js';

function log(actor: 'Setup' | 'SP' | 'Helix ID' | 'Agent', message: string): void {
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
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`HelixID API at ${url} did not become healthy in time.`);
}

/** The agent's DID, onboarding it on a first run. */
async function onboardAgent(): Promise<string> {
  const dir = agentDir(env.walletsDir);
  const existing = await readFile(join(dir, 'helix-agent.json'), 'utf8').catch(() => null);
  if (existing) {
    const { did } = JSON.parse(existing) as { did: string };
    log('Setup', `Agent already onboarded; reusing ${did}.`);
    return did;
  }
  const res = await fetch(`${env.helixApiUrl}/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-api-key': env.adminApiKey },
    body: JSON.stringify({ name: 'Travel Planner Agent', scopes: AGENT_PRIVILEGE_SCOPES, keyCustody: 'self' }),
  });
  const created = (await res.json()) as { did?: string; enrollmentToken?: string; error?: { message?: string } };
  if (!res.ok || !created.enrollmentToken) throw new Error(created.error?.message ?? `agent creation failed: HTTP ${res.status}`);
  // The key is generated here and never leaves this directory; Helix gets the public key and a proof of possession.
  const init = await helixInit({ apiUrl: env.helixApiUrl, enrollmentToken: created.enrollmentToken, outDir: dir });
  log('Helix ID', `Onboarded agent ${init.did} (${init.label}, status ${init.status}).`);
  return init.did;
}

async function main(): Promise<void> {
  await mkdir(env.walletsDir, { recursive: true });
  await waitForApi(env.helixApiUrl);

  const enrolled: Array<{ id: string; did: string }> = [];
  for (const sp of SPS) {
    const { identity, created } = await enrollSpService({
      dir: env.walletsDir,
      definition: sp,
      host: env.host,
      port: sp.port,
      helixApiUrl: env.helixApiUrl,
      adminApiKey: env.adminApiKey,
    });
    log('SP', created ? `Enrolled ${sp.displayName}: ${identity.did}` : `${sp.displayName} already enrolled (${identity.did}); reusing.`);
    enrolled.push({ id: sp.id, did: identity.did });
  }

  const agentDid = await onboardAgent();

  console.log('');
  log('Setup', 'Seed complete.');
  log('Agent', `Travel Planner DID : ${agentDid}`);
  log('Agent', `Attested scopes    : ${AGENT_PRIVILEGE_SCOPES.join(', ')}`);
  for (const sp of enrolled) log('SP', `${sp.id} DID          : ${sp.did}`);
  log('Setup', `Console            : ${env.consoleUrl}`);
}

main().catch((error: unknown) => {
  console.error('[Setup] Seeding failed:', error);
  process.exit(1);
});
