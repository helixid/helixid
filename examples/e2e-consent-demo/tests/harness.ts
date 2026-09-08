// Shared two-SP harness for the cross-epic suite.
//
// Boots real SP servers on real ports with real did:web identities, so every
// assertion below runs against the shipped code paths — real DID resolution,
// real signing, real verifyVP, real status-list fetches.

import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HelixClient, type SignedVC } from '@helixid/sdk-js';
import {
  AGENT_PRIVILEGE_SCOPES,
  AIRLINE,
  HOTEL,
  type SpDefinition,
} from '../helixid-config/index.js';
import { createSpApp, type SpApp } from '../sp-shared/app.js';
import { provisionSpIdentity, statePath } from '../sp-shared/identity.js';
import { SpStore } from '../sp-shared/store.js';
import { onboardLiveAgent, startLiveApi } from '../../../tests/utils/liveApi.js';

export interface RunningSp {
  spApp: SpApp;
  server: Server;
  store: SpStore;
  baseUrl: string;
  mcpUrl: string;
  serviceDid: string;
  stateFile: string;
  definition: SpDefinition;
}

export interface Harness {
  workDir: string;
  airline: RunningSp;
  hotel: RunningSp;
  /** Signs presentations on the agent's behalf and reads its held grants. */
  client: HelixClient;
  agentDid: string;
  /** The live API's configured issuer DID, when it reports one. */
  platformDid: string | undefined;
  /** The live helix-api instance backing both SPs' verifyVP/issueGrant calls. */
  helixApiUrl: string;
  stop: () => Promise<void>;
}

async function startSp(
  workDir: string,
  definition: SpDefinition,
  port: number,
  helixApiUrl: string,
  host = 'localhost',
): Promise<RunningSp> {
  const { identity, statusList } = await provisionSpIdentity({
    dir: workDir,
    spId: definition.id,
    host,
    port,
  });
  const stateFile = statePath(workDir, definition.id);
  const store = await SpStore.open(stateFile, statusList);
  const baseUrl = `http://${host}:${port}`;

  const spApp = createSpApp({
    definition: { ...definition, port },
    issuer: {
      did: identity.did,
      privateKeyHex: identity.privateKeyHex,
      publicKeyHex: identity.publicKeyHex,
    },
    baseUrl,
    helixApiUrl,
    store,
  });

  const server = await new Promise<Server>((resolve) => {
    const listening = spApp.app.listen(port, host, () => resolve(listening));
  });

  return {
    spApp,
    server,
    store,
    baseUrl,
    mcpUrl: `${baseUrl}/api/mcp`,
    serviceDid: identity.did,
    stateFile,
    definition,
  };
}

/**
 * Every consent grant the platform holds for this agent and user.
 *
 * Replaces the wallet's own credential list: agent self-custody is retired,
 * so grants live on the platform, recorded when the issuing SP finalizes
 * them. listVCs() returns summaries without a credentialSubject, so each
 * active credential is read back in full.
 */
export async function heldGrants(
  client: HelixClient,
  agentDid: string,
  userDid: string,
): Promise<SignedVC[]> {
  const summaries = await client.listVCs({ subjectDid: agentDid, status: 'active' });
  const grants: SignedVC[] = [];
  for (const summary of summaries) {
    const vc = (await client.getVC(summary.vcId)).vc as SignedVC | undefined;
    if (!vc || !(vc.type as string[]).includes('DelegationGrantCredential')) continue;
    if ((vc.credentialSubject as unknown as { userDid?: string }).userDid === userDid) {
      grants.push(vc);
    }
  }
  return grants;
}

/** The platform's standing grant for one SP, if any. */
export async function heldGrant(
  client: HelixClient,
  agentDid: string,
  serviceDid: string,
  userDid: string,
): Promise<SignedVC | undefined> {
  const grants = await heldGrants(client, agentDid, userDid);
  return grants.find((vc) => {
    const subject = vc.credentialSubject as unknown as { serviceDid?: string };
    return (subject.serviceDid ?? vc.issuer) === serviceDid;
  });
}

export async function startHarness(airlinePort: number, hotelPort: number): Promise<Harness> {
  const workDir = await mkdtemp(join(tmpdir(), 'helix-crossepic-'));
  // issueGrant() and verifyVP() are API-mediated (docs/proposal-sdk-api-only.md),
  // so both SPs need a real helix-api to call — a fresh, fully-local (SQLite,
  // did:key) instance per run, same as the root workspace's own live suite.
  const api = await startLiveApi();
  const airline = await startSp(workDir, AIRLINE, airlinePort, api.baseUrl);
  const hotel = await startSp(workDir, HOTEL, hotelPort, api.baseUrl);
  // A real onboarded agent: the API holds its key, so it must know about it.
  const client = new HelixClient(api.baseUrl, { adminApiKey: api.adminApiKey });
  const agent = await onboardLiveAgent(api, client, {
    agentName: 'Travel Planner Agent',
    requestedScopes: [...AGENT_PRIVILEGE_SCOPES],
    requestedDomains: ['https://travel-planner.agent.example.com'],
  });

  return {
    workDir,
    airline,
    hotel,
    client,
    agentDid: agent.did,
    platformDid: api.issuerDid,
    helixApiUrl: api.baseUrl,
    stop: async () => {
      await new Promise<void>((resolve) => airline.server.close(() => resolve()));
      await new Promise<void>((resolve) => hotel.server.close(() => resolve()));
      await rm(workDir, { recursive: true, force: true });
      await api.stop();
    },
  };
}

/** Drives the SP's two consent routes exactly as the widget does. */
export async function grantConsent(
  sp: RunningSp,
  agentDid: string,
  userDid: string,
  scopeOverride?: string[],
): Promise<SignedVC> {
  const catalogRes = await fetch(
    `${sp.baseUrl}/api/consent/scopes?agentDid=${encodeURIComponent(agentDid)}`,
  );
  const { scopeOptions } = (await catalogRes.json()) as { scopeOptions: Array<{ scope: string }> };
  const scopes = scopeOverride ?? scopeOptions.map((option) => option.scope);

  const acceptRes = await fetch(`${sp.baseUrl}/api/consent/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentDid, userDid, scopes, durability: 'standing' }),
  });
  const body = (await acceptRes.json()) as { grantVC: SignedVC };
  return body.grantVC;
}
