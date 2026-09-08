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
    const agent = await onboardLiveAgent(api, client, {
      agentName: 'Live Expiry Agent',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-expiry.agent.example.com'],
    });

    try {
      const shortVc = await client.issueVC({
        subjectDid: agent.did,
        subjectType: 'agent',
        privilegeScopes: ['read:orders'],
        agentName: 'Live Expiry Agent',
        expiresInSeconds: 1,
      });

      // VP construction moved fully client-side (VPBuilder, over a held VC)
      // once /v1/vp/template was removed — see docs/proposal-sdk-api-only.md.
      // Pinned to the short-lived VC: the agent also holds its onboarding
      // credential, so the default subject-only lookup would be ambiguous.
      const signedVP = await signVPForAgent(client, agent.did, {
        targetService: 'amazon',
        userDid: 'did:hedera:testnet:live-user-placeholder',
        vcId: shortVc.vcId,
      });

      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const details = await client.getVC(shortVc.vcId);
      expect(details.status).toBe('expired');

      const verifyRes = await http.post('/v1/vp/verify').send({ signedVP });
      expect(verifyRes.statusCode).toBe(400);
      // The service preserves the specific failure for the caller rather than
      // collapsing everything to the generic code (see vp.service.ts's catch).
      expect(verifyRes.body.error.code).toBe('VC_EXPIRED');
    } finally {
      await agent.cleanup();
    }
  }, LIVE_HEDERA_TIMEOUT_MS);
});
