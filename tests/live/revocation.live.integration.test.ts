import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { kyaos } from '@helixid/sdk-js';
import { resolveDID } from '@helixid/core';
import {
  enrollLiveService,
  LIVE_HEDERA_TIMEOUT_MS,
  onboardLiveAgent,
  resetLiveTestDatabase,
  startLiveApi,
  type LiveApi,
} from '../utils/liveApi.js';

// KYA-OS story L3-C over the real server: the issuer's status list is served
// signed, POST /v1/revocations cascades from a root delegation hop to
// every hop below it, every affected bit flips on the republished list, and one
// signed SET per credential goes out on GET /v1/events/revocations.

interface StoredCredential {
  vcId: string;
  status: string;
  credential: { credentialStatus?: { statusListCredential: string; statusListIndex: string } };
}

interface AgentCredentials {
  identity: StoredCredential;
  attestations: StoredCredential[];
}

interface Hop {
  id: string;
  credentialStatus: { statusListCredential: string; statusListIndex: string };
}

const resolveDid = async (did: string): Promise<never> => (await resolveDID(did)) as never;

/** Reads SSE frames from an open stream until `done` says enough. */
async function readSignals(response: Response, done: (sets: string[]) => boolean, timeoutMs = 15_000): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const sets: string[] = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (!done(sets)) {
    if (Date.now() > deadline) throw new Error(`timed out after ${sets.length} signal(s)`);
    const { value, done: ended } = await reader.read();
    if (ended) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      if (data) sets.push(data.slice('data: '.length));
    }
  }
  await reader.cancel();
  return sets;
}

describe('Revocation Live Integration (L3-C)', () => {
  let api: LiveApi;

  beforeAll(async () => {
    await resetLiveTestDatabase();
    api = await startLiveApi();
  });

  afterAll(async () => {
    await api?.stop();
  });

  async function credentialsOf(agentDid: string): Promise<AgentCredentials> {
    const res = await supertest(api.baseUrl)
      .get(`/v1/agents/${encodeURIComponent(agentDid)}/credentials`)
      .set('x-admin-api-key', api.adminApiKey);
    expect(res.statusCode).toBe(200);
    return res.body as AgentCredentials;
  }

  async function readList(url: string): Promise<kyaos.verifier.StatusListRead> {
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-cache');
    return kyaos.verifier.readBitstringStatusList(await res.json(), { resolveDid });
  }

  it('serves the issuer status list signed, with a proof that verifies by the issuer key', async () => {
    const agent = await onboardLiveAgent(api, {
      agentName: 'Live Status List Agent',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-status-list.agent.example.com'],
    });
    const { identity } = await credentialsOf(agent.did);
    const status = identity.credential.credentialStatus!;

    const read = await readList(status.statusListCredential);

    expect(read.issuer).toBe(api.issuerDid);
    expect(read.proofVerified).toBe(true);
    expect(kyaos.verifier.readStatusBit(read.bits, Number(status.statusListIndex))).toBe(0);
  }, LIVE_HEDERA_TIMEOUT_MS);

  it('revokes a root hop and every hop below it in one request, flips each bit on its issuer list, and signals each one', async () => {
    const service = await enrollLiveService(api, 'live-revocation-service');
    const parent = await onboardLiveAgent(api, {
      agentName: 'Live Revocation Parent',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-revocation-parent.agent.example.com'],
    });
    const child = await onboardLiveAgent(api, {
      agentName: 'Live Revocation Child',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-revocation-child.agent.example.com'],
    });
    const http = supertest(api.baseUrl);
    const rootRes = await http
      .post('/v1/grants')
      .set('x-admin-api-key', api.adminApiKey)
      .send({ issuer: api.issuerDid, invoker: parent.did, invocationTarget: service.did, allowedAction: ['read:orders'] });
    expect(rootRes.statusCode).toBe(201);
    const root = rootRes.body.hop as Hop;
    // Re-delegated by the parent, through the key Helix holds for it: an entry on the parent's own list.
    const childRes = await http
      .post(`/v1/grants/${encodeURIComponent(root.id)}/hops`)
      .set('x-admin-api-key', api.adminApiKey)
      .send({ invoker: child.did, allowedAction: ['read:orders'] });
    expect(childRes.statusCode).toBe(201);
    const leaf = childRes.body.hop as Hop;
    expect(leaf.credentialStatus.statusListCredential).not.toBe(root.credentialStatus.statusListCredential);

    for (const hop of [root, leaf]) {
      const read = await readList(hop.credentialStatus.statusListCredential);
      expect(kyaos.verifier.readStatusBit(read.bits, Number(hop.credentialStatus.statusListIndex))).toBe(0);
    }
    const stream = await fetch(`${api.baseUrl}/v1/events/revocations`, { headers: { accept: 'text/event-stream' } });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');

    const res = await http
      .post('/v1/revocations')
      .set('x-admin-api-key', api.adminApiKey)
      .send({ credentialId: root.id, revoker: api.issuerDid });
    expect(res.statusCode).toBe(200);
    expect(res.body.revoker).toBe(api.issuerDid);
    expect(res.body.revoked).toEqual([root.id, leaf.id]);

    // Each bit is set on its own issuer's republished list, each list signed by that issuer.
    const issuers: string[] = [];
    for (const hop of [root, leaf]) {
      const read = await readList(hop.credentialStatus.statusListCredential);
      expect(kyaos.verifier.readStatusBit(read.bits, Number(hop.credentialStatus.statusListIndex))).toBe(1);
      issuers.push(String(read.issuer));
    }
    expect(issuers).toEqual([api.issuerDid, parent.did]);

    // One SET per credential, signed by the Helix issuer.
    const sets = await readSignals(stream, (received) => received.length >= 2);
    const signalled: string[] = [];
    for (const set of sets) {
      const verdict = await kyaos.verifier.verifyRevocationSignal(set, { trustedIssuers: [api.issuerDid!], resolveDid });
      expect(verdict.ok).toBe(true);
      if (verdict.ok) signalled.push(String(verdict.signal.credentialId));
    }
    expect(signalled).toEqual([root.id, leaf.id]);

    // A second request finds nothing left to revoke.
    const again = await http
      .post('/v1/revocations')
      .set('x-admin-api-key', api.adminApiKey)
      .send({ credentialId: root.id, revoker: api.issuerDid });
    expect(again.statusCode).toBe(409);
  }, LIVE_HEDERA_TIMEOUT_MS);

  it('never lets the subject revoke its own credential, and needs the admin key for the custodial form', async () => {
    const agent = await onboardLiveAgent(api, {
      agentName: 'Live Subject Revoker Agent',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-subject-revoker.agent.example.com'],
    });
    const { identity } = await credentialsOf(agent.did);
    const http = supertest(api.baseUrl);

    const bySubject = await http
      .post('/v1/revocations')
      .set('x-admin-api-key', api.adminApiKey)
      .send({ credentialId: identity.vcId, revoker: agent.did });
    expect(bySubject.statusCode).toBe(403);
    expect(JSON.stringify(bySubject.body)).toContain('REVOCATION_FORBIDDEN');

    const noKey = await http.post('/v1/revocations').send({ credentialId: identity.vcId, revoker: api.issuerDid });
    expect(noKey.statusCode).toBe(403);
    expect(JSON.stringify(noKey.body)).toContain('ADMIN_AUTH_REQUIRED');

    const unsigned = await http.post('/v1/revocations').send({ request: 'not.a.jws' });
    expect([400, 401]).toContain(unsigned.statusCode);

    expect((await credentialsOf(agent.did)).identity.status).toBe('active');
  }, LIVE_HEDERA_TIMEOUT_MS);
});
