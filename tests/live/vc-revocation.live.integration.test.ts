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

describe('VC Revocation Live Integration', () => {
  let api: LiveApi;

  beforeAll(async () => {
    await resetLiveTestDatabase();
    api = await startLiveApi();
  });

  afterAll(async () => {
    await api?.stop();
  });

  it('requires admin revocation and rejects VP verification after the VC is revoked', async () => {
    const client = new HelixClient(api.baseUrl, { adminApiKey: api.adminApiKey });
    const http = supertest(api.baseUrl);
    const agent = await onboardLiveAgent(api, client, {
      agentName: 'Live Revocation Agent',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-revocation.agent.example.com'],
    });

    try {
      const vcRecord = await client.getVC(agent.vcId);

      const signedVP = await signVPForAgent(client, agent.did, {
        targetService: 'amazon',
        userDid: 'did:hedera:testnet:live-user-placeholder',
        vcId: agent.vcId,
      });

      const unauthenticatedRevoke = await http.post(`/v1/vcs/${agent.vcId}/revoke`).send({});
      expect(unauthenticatedRevoke.statusCode).toBe(403);
      expect(unauthenticatedRevoke.body.error.code).toBe('ADMIN_AUTH_REQUIRED');

      const revokeRes = await http
        .post(`/v1/vcs/${agent.vcId}/revoke`)
        .set('x-admin-api-key', api.adminApiKey)
        .send({});
      expect(revokeRes.statusCode).toBe(200);
      expect(revokeRes.body.revoked).toBe(true);

      const revokedDetails = await client.getVC(agent.vcId);
      expect(revokedDetails.status).toBe('revoked');

      const verifyRes = await http.post('/v1/vp/verify').send({ signedVP });
      expect(verifyRes.statusCode).toBe(400);
      expect(verifyRes.body.error.code).toBe('VC_REVOKED');
    } finally {
      await agent.cleanup();
    }
  }, LIVE_HEDERA_TIMEOUT_MS);
});
