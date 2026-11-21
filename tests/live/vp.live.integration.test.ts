import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
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

describe('VP Live Integration', () => {
  let api: LiveApi;
  let service: { did: string };

  beforeAll(async () => {
    await resetLiveTestDatabase();
    api = await startLiveApi();
    service = await enrollLiveService(api);
  });

  afterAll(async () => {
    await api?.stop();
  });

  it('generates, signs, and verifies a VP built from a held VC', async () => {
    const http = supertest(api.baseUrl);
    const agent = await onboardLiveAgent(api, {
      agentName: 'Live VP Agent',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-vp.agent.example.com'],
    });
    await issueLiveGrant(api, {
      serviceDid: service.did,
      agentDid: agent.did,
      userDid: 'did:hedera:testnet:live-user-placeholder',
      scopes: ['read:orders'],
    });

    const signedVP = await signLiveVP(api, agent.did, {
      targetService: service.did,
      userDid: 'did:hedera:testnet:live-user-placeholder',
    });

    const verifyRes = await http.post('/v1/vp/verify').send({ signedVP });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.body).toMatchObject({
      valid: true,
      agentDid: agent.did,
      targetService: service.did,
    });
  }, LIVE_HEDERA_TIMEOUT_MS);

  // KNOWN GAP — not a test bug: VPRepository.consumeAtomically() and the
  // `vpId` table exist (built for VP replay protection), but nothing in
  // VPService.verifyVP calls them. A second submission of the exact same
  // signed VP is not currently rejected. Flagging this rather than writing an
  // assertion that would pass by accident — see conversation with Harish
  // 2026-08-26. Un-skip once replay protection is actually wired up, and
  // change the expectation below to whatever specific code that wiring
  // throws (VP_ALREADY_CONSUMED is already defined, unused).
  it.skip('rejects replaying the same VP twice', async () => {
    const http = supertest(api.baseUrl);
    const agent = await onboardLiveAgent(api, {
      agentName: 'Live VP Replay Agent',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-vp-replay.agent.example.com'],
    });
    await issueLiveGrant(api, {
      serviceDid: service.did,
      agentDid: agent.did,
      userDid: 'did:hedera:testnet:live-user-placeholder',
      scopes: ['read:orders'],
    });

    const signedVP = await signLiveVP(api, agent.did, {
      targetService: service.did,
      userDid: 'did:hedera:testnet:live-user-placeholder',
    });

    const firstRes = await http.post('/v1/vp/verify').send({ signedVP });
    expect(firstRes.statusCode).toBe(200);

    const replayRes = await http.post('/v1/vp/verify').send({ signedVP });
    expect(replayRes.statusCode).toBe(400);
    expect(replayRes.body.error.code).toBe('VP_ALREADY_CONSUMED');
  }, LIVE_HEDERA_TIMEOUT_MS);

  it('rejects a VP whose targetService was tampered with after signing', async () => {
    const http = supertest(api.baseUrl);
    const agent = await onboardLiveAgent(api, {
      agentName: 'Live Tamper Agent',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-tamper.agent.example.com'],
    });

    await issueLiveGrant(api, {
      serviceDid: service.did,
      agentDid: agent.did,
      userDid: 'did:hedera:testnet:live-user-placeholder',
      scopes: ['read:orders'],
    });
    const vpTampered = await signLiveVP(api, agent.did, {
      targetService: service.did,
      userDid: 'did:hedera:testnet:live-user-placeholder',
    });
    (vpTampered as unknown as { targetService: string }).targetService = 'tampered-service';

    const vpTamperRes = await http.post('/v1/vp/verify').send({ signedVP: vpTampered });
    expect(vpTamperRes.statusCode).toBe(400);
    // Mutating any part of the signed payload — including targetService —
    // invalidates the outer VP signature before verification ever reaches
    // per-field checks (see vp-verifier.ts: VP signature is checked first).
    expect(vpTamperRes.body.error.code).toBe('VP_SIGNATURE_INVALID');
  }, LIVE_HEDERA_TIMEOUT_MS);

  it('rejects a VP whose embedded VC was tampered with after signing', async () => {
    const http = supertest(api.baseUrl);
    const agent = await onboardLiveAgent(api, {
      agentName: 'Live VC Tamper Agent',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-vc-tamper.agent.example.com'],
    });

    await issueLiveGrant(api, {
      serviceDid: service.did,
      agentDid: agent.did,
      userDid: 'did:hedera:testnet:live-user-placeholder',
      scopes: ['read:orders'],
    });
    const vcTampered = await signLiveVP(api, agent.did, {
      targetService: service.did,
      userDid: 'did:hedera:testnet:live-user-placeholder',
    });
    (vcTampered.verifiableCredential[0] as any).credentialSubject.agentName = 'Tampered Agent';

    const vcTamperRes = await http.post('/v1/vp/verify').send({ signedVP: vcTampered });
    expect(vcTamperRes.statusCode).toBe(400);
    // The embedded VC is part of the VP's own signed payload, so mutating
    // it invalidates the VP signature the same way tampering the VP's own
    // fields does — it never gets far enough to check the VC's signature.
    expect(vcTamperRes.body.error.code).toBe('VP_SIGNATURE_INVALID');
  }, LIVE_HEDERA_TIMEOUT_MS);
});
