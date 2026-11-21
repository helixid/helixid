import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import {
  LIVE_HEDERA_TIMEOUT_MS,
  enrollLiveService,
  issueLiveGrant,
  onboardLiveAgent,
  resetLiveTestDatabase,
  signLiveVP,
  startLiveApi,
  type LiveApi,
} from '../utils/liveApi.js';

// Consent-grant flow (§2a) — a user's consent for an agent to act on their
// behalf, within a service provider's context. Modeled the way a real SP
// integration works since the service-provider revamp: the service is
// enrolled on this API, which mints its DID and holds its key, and the
// service issues the grant through POST /v1/service-delegation-grants, so
// the platform both signs and holds it. signVP then looks the grant up by
// (agent, service, user).
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
    const http = supertest(api.baseUrl);
    const agent = await onboardLiveAgent(api, {
      agentName: 'Live Consent Grant Agent',
      requestedScopes: ['read:orders', 'write:orders'],
      requestedDomains: ['https://live-consent.agent.example.com'],
    });

    // The SP's own identity — the grant's issuer.
    const spDid = (await enrollLiveService(api, 'live-consent-sp')).did;
    const userDid = 'did:key:zLiveConsentUser';

    // The user consented to read-only access — narrower than the agent's
    // full onboarded privilege scopes (read+write).
    await issueLiveGrant(api, { serviceDid: spDid, agentDid: agent.did, userDid, scopes: ['read:orders'] });

    const signedVP = await signLiveVP(api, agent.did, { targetService: spDid, userDid });

    const verifyRes = await http.post('/v1/vp/verify').send({ signedVP });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.body).toMatchObject({
      valid: true,
      agentDid: agent.did,
      userDid,
      privilegeScopes: expect.arrayContaining(['read:orders', 'write:orders']),
      effectiveScopes: ['read:orders'],
    });
  }, LIVE_HEDERA_TIMEOUT_MS);

  it('refuses to sign a VP for a user the agent holds no grant for', async () => {
    const http = supertest(api.baseUrl);
    const agent = await onboardLiveAgent(api, {
      agentName: 'Live Consent Mismatch Agent',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-consent-mismatch.agent.example.com'],
    });

    const spDid = (await enrollLiveService(api, 'live-consent-mismatch-sp')).did;
    await issueLiveGrant(api, {
      serviceDid: spDid,
      agentDid: agent.did,
      userDid: 'did:key:zGrantedForThisUser',
      scopes: ['read:orders'],
    });

    // Asked to act for a *different* user than the grant covers: there is
    // no grant to look up, so no VP is signed at all.
    const signRes = await http
      .post(`/v1/agents/${encodeURIComponent(agent.did)}/vp`)
      .set('x-admin-api-key', api.adminApiKey)
      .send({ targetService: spDid, userDid: 'did:key:zSomeoneElseEntirely' });
    expect(signRes.statusCode).toBe(404);
    expect(signRes.body.error.code).toBe('CONSENT_GRANT_NOT_FOUND');
  }, LIVE_HEDERA_TIMEOUT_MS);
});
