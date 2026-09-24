// The activity trail an SP emits for one guarded tool call.
//
// The point of these assertions is the *sequence and its verdicts*, not the
// prose: presentation, cryptographic verdict, policy verdict, and action are
// four separate records, and the interesting case is the one where the first
// two succeed and the third still refuses.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearDIDCache, HelixClient, type SignedVC } from '@helixid/sdk-js';
import { AIRLINE, AGENT_PRIVILEGE_SCOPES, DEMO_USER_DID } from '../helixid-config/index.js';
import { createSpApp } from '../sp-shared/app.js';
import type { ActivityEvent } from '../sp-shared/audit.js';
import { provisionSpIdentity, statePath } from '../sp-shared/identity.js';
import { SpStore } from '../sp-shared/store.js';
import {
  onboardLiveAgent,
  signVPForAgent,
  startLiveApi,
  type LiveApi,
} from '../../../tests/utils/liveApi.js';

const HOST = 'localhost';
const PORT = 14301;

let workDir: string;
let api: LiveApi;
let server: Server;
let baseUrl: string;
let client: HelixClient;
let agentDid: string;
let serviceDid: string;
const recorded: ActivityEvent[] = [];

/** Records instead of POSTing, so assertions read the SP's own emissions. */
const recorder = { emit: (event: ActivityEvent) => void recorded.push(event) };

async function callTool(
  toolName: string,
  args: Record<string, unknown>,
  grant: SignedVC | undefined,
  correlationId: string,
): Promise<void> {
  // Server custody: the API signs with the agent's held key and attaches
  // the agent's own authority VC itself; only the grant is passed in.
  const vp = await signVPForAgent(client, agentDid, {
    targetService: serviceDid,
    userDid: DEMO_USER_DID,
    ...(grant ? { grantVC: grant } : {}),
  });

  await fetch(`${baseUrl}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: { ...args, _helixVP: vp, _helixCorrelationId: correlationId } },
    }),
  });
}

async function issueGrantFor(scopes: string[]): Promise<SignedVC> {
  const res = await fetch(`${baseUrl}/api/consent/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // accept-terms is a server-enforced required scope on every grant
    // (UX13) — every helper call here is exercising authz on the OTHER
    // scopes, not testing the required-scope check itself, so it always
    // gets included.
    body: JSON.stringify({
      agentDid,
      userDid: DEMO_USER_DID,
      scopes: [...scopes, 'accept-terms'],
      durability: 'standing',
    }),
  });
  return ((await res.json()) as { grantVC: SignedVC }).grantVC;
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'helix-audit-trail-'));
  clearDIDCache();
  // issueGrant() and verifyVP() are API-mediated (docs/proposal-sdk-api-only.md),
  // so the SP needs a real helix-api to call — a fresh, fully-local (SQLite,
  // did:key) instance per run, same as the root workspace's own live suite.
  api = await startLiveApi();

  const { identity, statusList } = await provisionSpIdentity({
    dir: workDir,
    spId: AIRLINE.id,
    host: HOST,
    port: PORT,
  });
  serviceDid = identity.did;
  baseUrl = `http://${HOST}:${PORT}`;

  const { app } = createSpApp({
    definition: { ...AIRLINE, port: PORT },
    issuer: {
      did: identity.did,
      privateKeyHex: identity.privateKeyHex,
      publicKeyHex: identity.publicKeyHex,
    },
    baseUrl,
    helixApiUrl: api.baseUrl,
    store: await SpStore.open(statePath(workDir, AIRLINE.id), statusList),
    audit: recorder,
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(PORT, HOST, () => resolve(s));
  });

  client = new HelixClient(api.baseUrl, { adminApiKey: api.adminApiKey });
  const agent = await onboardLiveAgent(api, client, {
    agentName: 'Travel Planner Agent',
    requestedScopes: AGENT_PRIVILEGE_SCOPES,
    requestedDomains: ['https://travel-planner.agent.example.com'],
  });
  agentDid = agent.did;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(workDir, { recursive: true, force: true });
  await api.stop();
});

beforeEach(() => {
  recorded.length = 0;
});

describe('SP activity trail', () => {
  it('records an open, read-only tool as an action needing no credential', async () => {
    await fetch(`${baseUrl}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'search_flights',
          arguments: {
            origin: 'TVM',
            destination: 'DEL',
            departureDate: '2026-09-01',
            _helixCorrelationId: 'act_open',
          },
        },
      }),
    });

    expect(recorded.map((e) => e.event)).toEqual(['TOOL_INVOKED']);
    expect(recorded[0]).toMatchObject({
      toolName: 'search_flights',
      result: 'success',
      reason: 'OPEN_TOOL_NO_SCOPE_REQUIRED',
      correlationId: 'act_open',
    });
    expect(recorded[0]?.resultSummary).toMatch(/flights? found/);
  });

  it('records issuance when the SP signs a grant', async () => {
    await issueGrantFor(['book:flights']);

    expect(recorded.map((e) => e.event)).toEqual(['VC_ISSUED']);
    expect(recorded[0]).toMatchObject({
      credentialType: 'DelegationGrantCredential',
      issuer: serviceDid,
      agentDid,
      userDid: DEMO_USER_DID,
      scopes: ['book:flights', 'accept-terms'],
      credentialStatus: 'active',
      result: 'success',
    });
    expect(recorded[0]?.vcId).toBeTruthy();
  });

  it('blocks a guarded tool presented with no credential at all', async () => {
    await fetch(`${baseUrl}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'book_flight', arguments: { flightId: 'HA-401' } },
      }),
    });

    expect(recorded.map((e) => e.event)).toEqual(['AUTHZ_DENIED']);
    expect(recorded[0]).toMatchObject({ reason: 'NO_PRESENTATION', result: 'blocked' });
  });

  it('verifies the presentation but blocks when this SP granted nothing', async () => {
    await callTool('book_flight', { flightId: 'HA-401' }, undefined, 'act_nogrant');

    expect(recorded.map((e) => e.event)).toEqual([
      'VC_PRESENTED',
      'VP_VERIFIED',
      'AUTHZ_DENIED',
    ]);
    expect(recorded.every((e) => e.correlationId === 'act_nogrant')).toBe(true);
    expect(recorded[1]).toMatchObject({ result: 'success' });
    expect(recorded[2]).toMatchObject({
      reason: 'NO_GRANT_FOR_THIS_SERVICE',
      result: 'blocked',
    });
  });

  // The case the whole model exists for: nothing is wrong with the credential,
  // and the action is refused anyway.
  it('verifies successfully and still blocks when the granted scope is insufficient', async () => {
    const grant = await issueGrantFor(['modify:booking']);
    recorded.length = 0;

    await callTool('book_flight', { flightId: 'HA-401' }, grant, 'act_scope');

    expect(recorded.map((e) => e.event)).toEqual([
      'VC_PRESENTED',
      'VP_VERIFIED',
      'AUTHZ_DENIED',
    ]);
    expect(recorded[1]).toMatchObject({ event: 'VP_VERIFIED', result: 'success' });
    expect(recorded[2]).toMatchObject({
      event: 'AUTHZ_DENIED',
      result: 'blocked',
      reason: 'INSUFFICIENT_EFFECTIVE_SCOPE',
      requiredScope: 'book:flights',
      effectiveScopes: ['modify:booking'],
    });
    expect(recorded[2]?.resultSummary).toContain('book:flights');
  });

  it('records the full success chain through to the action and its result', async () => {
    const grant = await issueGrantFor(['book:flights']);
    recorded.length = 0;

    await callTool('book_flight', { flightId: 'HA-401' }, grant, 'act_ok');

    expect(recorded.map((e) => e.event)).toEqual([
      'VC_PRESENTED',
      'VP_VERIFIED',
      'AUTHZ_GRANTED',
      'TOOL_INVOKED',
    ]);
    expect(recorded.every((e) => e.correlationId === 'act_ok')).toBe(true);
    expect(recorded.every((e) => e.result === 'success')).toBe(true);
    expect(recorded[2]).toMatchObject({
      requiredScope: 'book:flights',
      effectiveScopes: ['book:flights'],
      vcId: grant.id,
    });
    // The action record carries the booking the caller actually received.
    expect(recorded[3]?.resultSummary).toMatch(/CONFIRMED — FLT-/);
  });
});
