import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { HelixClient } from '@helixid/sdk-js';
import type { SignedVC } from '@helixid/sdk-js';
import {
  LIVE_HEDERA_TIMEOUT_MS,
  signVPForAgent,
  onboardLiveAgent,
  resetLiveTestDatabase,
  startLiveApi,
  type LiveApi,
} from '../utils/liveApi.js';

// Renewal here is HelixClient.renewVC() — the server-signed path for a VC the
// hosted issuer originally signed (which is what onboarding produces). This
// is distinct from the SDK's renewAgentVC()/prepare-finalize path, which is
// for VCs the agent self-signed and must re-sign itself.
describe('VC Renewal Live Integration', () => {
  let api: LiveApi;

  beforeAll(async () => {
    await resetLiveTestDatabase();
    api = await startLiveApi();
  });

  afterAll(async () => {
    await api?.stop();
  });

  it('issues a fresh VC on renewal and links it back to the one it replaces', async () => {
    const client = new HelixClient(api.baseUrl, { adminApiKey: api.adminApiKey });
    const http = supertest(api.baseUrl);
    const agent = await onboardLiveAgent(api, client, {
      agentName: 'Live Renewal Agent',
      requestedScopes: ['read:orders', 'write:orders'],
      requestedDomains: ['https://live-renewal.agent.example.com'],
    });

    try {
      const renewed = await client.renewVC(agent.vcId, {
        privilegeScopes: ['read:orders'],
      });

      expect(renewed.vcId).not.toBe(agent.vcId);
      expect((renewed.vc as Record<string, unknown>)['credentialSubject']).toMatchObject({
        id: agent.did,
        privilegeScopes: ['read:orders'],
      });

      const oldVcDetails = await client.getVC(agent.vcId);
      expect(oldVcDetails.renewedByVcId).toBe(renewed.vcId);

      // The old VC still verifies with its original (wider) scopes — renewal
      // doesn't revoke it, it's a separate credential lineage.
      // Both the original and the renewed credential are active, so each VP
      // pins the one it is presenting.
      const oldSignedVP = await signVPForAgent(client, agent.did, {
        targetService: 'amazon',
        userDid: 'did:hedera:testnet:live-user-placeholder',
        vcId: agent.vcId,
      });
      const oldVerifyRes = await http.post('/v1/vp/verify').send({ signedVP: oldSignedVP });
      expect(oldVerifyRes.statusCode).toBe(200);
      expect(oldVerifyRes.body.privilegeScopes).toEqual(
        expect.arrayContaining(['read:orders', 'write:orders']),
      );

      // The new (renewed) VC verifies too, with the narrowed scopes.
      const newSignedVP = await signVPForAgent(client, agent.did, {
        targetService: 'amazon',
        userDid: 'did:hedera:testnet:live-user-placeholder',
        vcId: renewed.vcId,
      });
      const newVerifyRes = await http.post('/v1/vp/verify').send({ signedVP: newSignedVP });
      expect(newVerifyRes.statusCode).toBe(200);
      expect(newVerifyRes.body.privilegeScopes).toEqual(['read:orders']);
    } finally {
      await agent.cleanup();
    }
  }, LIVE_HEDERA_TIMEOUT_MS);

  it('rejects renewing an already-revoked VC', async () => {
    const client = new HelixClient(api.baseUrl, { adminApiKey: api.adminApiKey });
    const http = supertest(api.baseUrl);
    const agent = await onboardLiveAgent(api, client, {
      agentName: 'Live Renewal Revoked Agent',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-renewal-revoked.agent.example.com'],
    });

    try {
      await http
        .post(`/v1/vcs/${agent.vcId}/revoke`)
        .set('x-admin-api-key', api.adminApiKey)
        .send({});

      await expect(client.renewVC(agent.vcId, {})).rejects.toMatchObject({
        code: 'VC_ALREADY_REVOKED',
      });
    } finally {
      await agent.cleanup();
    }
  }, LIVE_HEDERA_TIMEOUT_MS);
});
