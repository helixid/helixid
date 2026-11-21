import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { HelixClient } from '@helixid/sdk-js';
import {
  LIVE_HEDERA_TIMEOUT_MS,
  onboardLiveAgent,
  resetLiveTestDatabase,
  enrollLiveService,
  signLiveVP,
  startLiveApi,
  type LiveApi,
} from '../utils/liveApi.js';

// Renewal here is HelixClient.renewVC() — the server-signed path for a VC the
// hosted issuer originally signed (which is what onboarding produces).
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
    const agent = await onboardLiveAgent(api, {
      agentName: 'Live Renewal Agent',
      requestedScopes: ['read:orders', 'write:orders'],
      requestedDomains: ['https://live-renewal.agent.example.com'],
    });

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

    // The old VC stays active with its original (wider) scopes — renewal
    // doesn't revoke it, it's a separate credential lineage. The VP carries
    // both, and the verifier takes the union of their scopes.
    const service = await enrollLiveService(api);
    const signedVP = await signLiveVP(api, agent.did, { targetService: service.did });
    const credentialIds = signedVP.verifiableCredential.map((vc) => (vc as { id: string }).id);
    expect(credentialIds).toEqual(expect.arrayContaining([agent.vcId, renewed.vcId]));
    const verifyRes = await http.post('/v1/vp/verify').send({ signedVP });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.body.privilegeScopes).toEqual(
      expect.arrayContaining(['read:orders', 'write:orders']),
    );
  }, LIVE_HEDERA_TIMEOUT_MS);

  it('rejects renewing an already-revoked VC', async () => {
    const client = new HelixClient(api.baseUrl, { adminApiKey: api.adminApiKey });
    const http = supertest(api.baseUrl);
    const agent = await onboardLiveAgent(api, {
      agentName: 'Live Renewal Revoked Agent',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-renewal-revoked.agent.example.com'],
    });

    await http
      .post(`/v1/vcs/${agent.vcId}/revoke`)
      .set('x-admin-api-key', api.adminApiKey)
      .send({});

    await expect(client.renewVC(agent.vcId, {})).rejects.toMatchObject({
      code: 'VC_ALREADY_REVOKED',
    });
  }, LIVE_HEDERA_TIMEOUT_MS);
});
