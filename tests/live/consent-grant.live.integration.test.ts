import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { HelixClient, generateKeyPair, issueGrant, publicKeyToMultibase } from '@helixid/sdk-js';
import type { SignedVC } from '@helixid/sdk-js';
import {
  LIVE_HEDERA_TIMEOUT_MS,
  signVPForAgent,
  onboardLiveAgent,
  resetLiveTestDatabase,
  startLiveApi,
  type LiveApi,
} from '../utils/liveApi.js';

// Consent-grant flow (§2a) — a user's consent for an agent to act on their
// behalf, within a service provider's context. Modeled the way a real SP
// integration would: the SP holds its own signing key (never the hosted
// issuer's, never the agent's) and issues the grant via prepare/finalize, so
// its private key never leaves this process either. The SP's DID is a
// locally-resolvable did:key here rather than one registered through this
// API — grants can come from any issuer whose key the API can resolve, and
// did:key is the simplest real one that needs no separate registration step.
describe('Consent Grant Live Integration', () => {
  let api: LiveApi;

  beforeAll(async () => {
    await resetLiveTestDatabase();
    api = await startLiveApi();
  });

  afterAll(async () => {
    await api?.stop();
  });

  it('narrows an agent VP to the grant-intersected scopes a user actually consented to', async () => {
    const client = new HelixClient(api.baseUrl, { adminApiKey: api.adminApiKey });
    const http = supertest(api.baseUrl);
    const agent = await onboardLiveAgent(api, client, {
      agentName: 'Live Consent Grant Agent',
      requestedScopes: ['read:orders', 'write:orders'],
      requestedDomains: ['https://live-consent.agent.example.com'],
    });

    try {
      // The SP's own identity — issues the grant with its own key.
      const sp = generateKeyPair();
      const spDid = `did:key:${publicKeyToMultibase(sp.publicKey)}`;
      const userDid = 'did:key:zLiveConsentUser';

      // Hosted on this same API instance via its public status-list endpoint
      // — a real HTTP-fetchable status list, exercising the real revocation
      // plumbing rather than an in-memory stand-in.
      const statusList = await client.createStatusList({ length: 64 });

      // The user consented to read-only access — narrower than the agent's
      // full onboarded privilege scopes (read+write).
      const { grantVC } = await issueGrant(
        {
          agentDid: agent.did,
          userDid,
          scopes: ['read:orders'],
          durability: 'standing',
          statusList,
          statusListCredentialUrl: statusList.id,
        },
        { did: spDid, privateKeyHex: sp.privateKey },
        client,
      );

      const vcRecord = await client.getVC(agent.vcId);
      // The grant travels as a separate credential — never merged into the
      // agent credential's own delegation chain.
      const signedVP = await signVPForAgent(client, agent.did, {
        targetService: 'amazon',
        userDid,
        grantVC,
        vcId: agent.vcId,
      });

      const verifyRes = await http.post('/v1/vp/verify').send({ signedVP });
      expect(verifyRes.statusCode).toBe(200);
      expect(verifyRes.body).toMatchObject({
        valid: true,
        agentDid: agent.did,
        userDid,
        privilegeScopes: expect.arrayContaining(['read:orders', 'write:orders']),
        effectiveScopes: ['read:orders'],
      });
    } finally {
      await agent.cleanup();
    }
  }, LIVE_HEDERA_TIMEOUT_MS);

  it('rejects a VP when the grant is for a different user than the VP claims', async () => {
    const client = new HelixClient(api.baseUrl, { adminApiKey: api.adminApiKey });
    const http = supertest(api.baseUrl);
    const agent = await onboardLiveAgent(api, client, {
      agentName: 'Live Consent Mismatch Agent',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-consent-mismatch.agent.example.com'],
    });

    try {
      const sp = generateKeyPair();
      const spDid = `did:key:${publicKeyToMultibase(sp.publicKey)}`;
      const statusList = await client.createStatusList({ length: 64 });

      const { grantVC } = await issueGrant(
        {
          agentDid: agent.did,
          userDid: 'did:key:zGrantedForThisUser',
          scopes: ['read:orders'],
          durability: 'standing',
          statusList,
          statusListCredentialUrl: statusList.id,
        },
        { did: spDid, privateKeyHex: sp.privateKey },
        client,
      );

      const vcRecord = await client.getVC(agent.vcId);
      // Signed as if acting for a *different* user than the grant covers.
      const signedVP = await signVPForAgent(client, agent.did, {
        targetService: 'amazon',
        userDid: 'did:key:zSomeoneElseEntirely',
        grantVC,
        vcId: agent.vcId,
      });

      const verifyRes = await http.post('/v1/vp/verify').send({ signedVP });
      expect(verifyRes.statusCode).toBe(400);
      expect(verifyRes.body.error.code).toBe('CONSENT_GRANT_SUBJECT_MISMATCH');
    } finally {
      await agent.cleanup();
    }
  }, LIVE_HEDERA_TIMEOUT_MS);
});
