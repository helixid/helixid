import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { verifyJWT } from '@helixid/core';
import {
  LIVE_HEDERA_TIMEOUT_MS,
  onboardLiveAgent,
  resetLiveTestDatabase,
  enrollLiveService,
  issueLiveGrant,
  signLiveVP,
  startLiveApi,
  type LiveApi,
} from '../utils/liveApi.js';

describe('JWT Session Live Integration', () => {
  let api: LiveApi;

  beforeAll(async () => {
    await resetLiveTestDatabase();
    api = await startLiveApi();
  });

  afterAll(async () => {
    await api?.stop();
  });

  it('verifies a VP once, then authorizes repeated book-order actions with the JWT session', async () => {
    const http = supertest(api.baseUrl);
    const agent = await onboardLiveAgent(api, {
      agentName: 'Live JWT Session Agent',
      requestedScopes: ['read:orders', 'write:orders'],
      requestedDomains: ['https://live-jwt-session.agent.example.com'],
    });

    const service = await enrollLiveService(api);
    await issueLiveGrant(api, {
      serviceDid: service.did,
      agentDid: agent.did,
      userDid: 'did:hedera:testnet:live-book-buyer',
      scopes: ['read:orders', 'write:orders'],
    });
    const signedVP = await signLiveVP(api, agent.did, {
      targetService: service.did,
      userDid: 'did:hedera:testnet:live-book-buyer',
    });

    const verifyRes = await http.post('/v1/vp/verify').send({ signedVP, session: true });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.body).toMatchObject({
      valid: true,
      agentDid: agent.did,
      userDid: 'did:hedera:testnet:live-book-buyer',
      targetService: service.did,
    });
    expect(verifyRes.body.session?.token).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
    expect(verifyRes.body.session?.publicKeyEndpoint).toBe('/v1/sessions/public-key');

    const publicKeyRes = await http.get('/v1/sessions/public-key');
    expect(publicKeyRes.statusCode).toBe(200);
    expect(publicKeyRes.body).toMatchObject({
      alg: 'EdDSA',
      crv: 'Ed25519',
    });
    expect(publicKeyRes.body.publicKeyHex).toMatch(/^[0-9a-f]+$/i);

    const publicKeyHex = publicKeyRes.body.publicKeyHex;
    const sessionToken = verifyRes.body.session?.token;
    expect(sessionToken).toBeTypeOf('string');
    if (!sessionToken) {
      throw new Error('Expected JWT session token to be returned');
    }

    // The whole point of a JWT session: repeated actions are authorized by
    // verifying the token locally (no round trip to the API), each time
    // re-checking claims against what the caller expects for this request.
    const authorizeBookAction = async (action: 'search-book' | 'add-book-to-cart' | 'place-book-order'): Promise<void> => {
      const payload = verifyJWT(sessionToken, publicKeyHex);
      expect(payload.sub).toBe(agent.did);
      expect(payload.userDid).toBe('did:hedera:testnet:live-book-buyer');
      expect(payload.targetService).toBe(service.did);
      expect(payload.scopes).toEqual(expect.arrayContaining(['read:orders', 'write:orders']));
      expect(payload.vpId).toBe(signedVP.id);
      expect(action).toMatch(/book/);
    };

    await authorizeBookAction('search-book');
    await authorizeBookAction('add-book-to-cart');
    await authorizeBookAction('place-book-order');

    // Note: a *second* POST /v1/vp/verify with the same signedVP is not
    // exercised here — VP replay protection (VPRepository/vpId table) is a
    // known gap, not yet wired into VPService.verifyVP. See the skipped
    // test in vp.live.integration.test.ts.
  }, LIVE_HEDERA_TIMEOUT_MS);
});
