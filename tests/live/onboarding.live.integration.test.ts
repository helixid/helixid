import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { HelixClient } from '@helixid/sdk-js';
import {
  LIVE_HEDERA_TIMEOUT_MS,
  onboardLiveAgent,
  resetLiveTestDatabase,
  startLiveApi,
  type LiveApi,
} from '../utils/liveApi.js';

describe('Onboarding Live Integration', () => {
  let api: LiveApi;

  beforeAll(async () => {
    await resetLiveTestDatabase();
    api = await startLiveApi();
  });

  afterAll(async () => {
    await api?.stop();
  });

  it('onboards an agent server-side in one call and persists DID, VC, key, and audit state — no wallet', async () => {
    const client = new HelixClient(api.baseUrl, { adminApiKey: api.adminApiKey });
    const agent = await onboardLiveAgent(api, {
      agentName: 'Live Onboarding Agent',
      requestedScopes: ['read:orders', 'write:orders'],
      requestedDomains: ['https://live-onboarding.agent.example.com'],
    });

    // Agent DIDs are minted per the server's configured DID_METHOD (see
    // DIDService.createDID) — did:hedera in production, but did:key/did:web
    // work equally well and need no Hedera network at all, so this only
    // pins the shape, not a specific method.
    expect(agent.did).toMatch(/^did:(hedera:testnet:[a-zA-Z0-9._-]+|key:z\w+|web:[\w.:%-]+)$/);
    // F-1: the onboarding VC is the agent's identity credential, id urn:uuid:<v4>.
    expect(agent.vcId).toMatch(/^urn:uuid:/);

    const didRes = await supertest(api.baseUrl).get(`/v1/dids/${agent.did}`);
    expect(didRes.statusCode).toBe(200);
    expect(didRes.body.id).toBe(agent.did);
    expect(didRes.body.service[0].serviceEndpoint).toBe('https://live-onboarding.agent.example.com');

    // Storage-agnostic: goes through the public API rather than a raw
    // Prisma/Postgres query, so this passes under any configured storage
    // adapter (sqlite in this sandbox, Postgres elsewhere).
    const vcRecord = await client.getVC(agent.vcId);
    const identity = vcRecord.vc as Record<string, unknown>;
    expect(identity['issuer']).toBe(api.issuerDid);
    expect(vcRecord.status).toBe('active');
    expect(identity['type']).toEqual(expect.arrayContaining(['VerifiableCredential', 'AgentIdentityCredential']));
    expect(identity['credentialSubject']).toMatchObject({
      id: agent.did,
      name: 'Live Onboarding Agent',
      responsibleParty: api.issuerDid,
    });
    expect((identity['proof'] as { type: string; cryptosuite: string; verificationMethod: string })).toMatchObject({
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      verificationMethod: `${api.issuerDid}#key-1`,
    });

    // One capability attestation per requested scope, kept by Helix next to the identity.
    const credentialsRes = await supertest(api.baseUrl)
      .get(`/v1/agents/${encodeURIComponent(agent.did)}/credentials`)
      .set('x-admin-api-key', api.adminApiKey);
    expect(credentialsRes.statusCode).toBe(200);
    expect(credentialsRes.body.identity.vcId).toBe(agent.vcId);
    const attested = (credentialsRes.body.attestations as Array<{ status: string; credential: { credentialSubject: { capability: string } } }>)
      .map((entry) => [entry.credential.credentialSubject.capability, entry.status])
      .sort();
    expect(attested).toEqual([['read:orders', 'active'], ['write:orders', 'active']]);

    // No wallet file, no client-held key — the server generated and holds
    // the agent's private key itself (AgentKey table); nothing in the
    // onboarding exchange carried a private key.

    // GET /v1/audit-log returns one page, `{ items, nextCursor }`, each item a
    // `{id, recordedAt, eventDigest, event, ...receipt}` row whose `event` is a
    // typed producer event (stories A-1, A-2).
    const auditLog = (await client.getAuditLog({ limit: 100 })) as unknown as {
      items: Array<{ event: { eventType: string } }>;
    };
    const auditTypes = auditLog.items.map((entry) => entry.event.eventType);
    expect(auditTypes).toEqual(expect.arrayContaining([
      'credential.required',   // enrollment token generated, onboarding challenge issued
      'credential.verified',   // token consumed, challenge verified, agent onboarded
      'configuration.changed', // DID created
      'delegation.issued',     // identity credential and capability attestations issued
    ]));
  }, LIVE_HEDERA_TIMEOUT_MS);
});
