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

describe('VC Expiry Live Integration', () => {
  let api: LiveApi;

  beforeAll(async () => {
    await resetLiveTestDatabase();
    api = await startLiveApi();
  });

  afterAll(async () => {
    await api?.stop();
  });

  it('rejects a VP carrying a VC that expired after signing', async () => {
    const client = new HelixClient(api.baseUrl, { adminApiKey: api.adminApiKey });
    const http = supertest(api.baseUrl);
    const agent = await onboardLiveAgent(api, {
      agentName: 'Live Expiry Agent',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-expiry.agent.example.com'],
    });

    const shortVc = await client.issueVC({
      subjectDid: agent.did,
      subjectType: 'agent',
      privilegeScopes: ['read:orders'],
      agentName: 'Live Expiry Agent',
      expiresInSeconds: 1,
    });

    // The agent now has two active HelixAgentCredentials (its onboarding VC
    // and this short-lived one); the VP carries both, so the short-lived
    // one expiring is enough to reject it.
    const service = await enrollLiveService(api);
    const signedVP = await signLiveVP(api, agent.did, { targetService: service.did });

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const details = await client.getVC(shortVc.vcId);
    expect(details.status).toBe('expired');

    const verifyRes = await http.post('/v1/vp/verify').send({ signedVP });
    expect(verifyRes.statusCode).toBe(400);
    // The service preserves the specific failure for the caller rather than
    // collapsing everything to the generic code (see vp.service.ts's catch).
    expect(verifyRes.body.error.code).toBe('VC_EXPIRED');
  }, LIVE_HEDERA_TIMEOUT_MS);
});
