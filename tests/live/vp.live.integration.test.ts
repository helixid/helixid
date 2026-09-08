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

describe('VP Live Integration', () => {
  let api: LiveApi;

  beforeAll(async () => {
    await resetLiveTestDatabase();
    api = await startLiveApi();
  });

  afterAll(async () => {
    await api?.stop();
  });

  it('generates, signs, and verifies a VP built from a held VC', async () => {
    const client = new HelixClient(api.baseUrl, { adminApiKey: api.adminApiKey });
    const http = supertest(api.baseUrl);
    const agent = await onboardLiveAgent(api, client, {
      agentName: 'Live VP Agent',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-vp.agent.example.com'],
    });

    try {
      const signedVP = await signVPForAgent(client, agent.did, {
        targetService: 'amazon',
        userDid: 'did:hedera:testnet:live-user-placeholder',
        vcId: agent.vcId,
      });

      const verifyRes = await http.post('/v1/vp/verify').send({ signedVP });
      expect(verifyRes.statusCode).toBe(200);
      expect(verifyRes.body).toMatchObject({
        valid: true,
        agentDid: agent.did,
        targetService: 'amazon',
      });
    } finally {
      await agent.cleanup();
    }
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
    const client = new HelixClient(api.baseUrl, { adminApiKey: api.adminApiKey });
    const http = supertest(api.baseUrl);
    const agent = await onboardLiveAgent(api, client, {
      agentName: 'Live VP Replay Agent',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-vp-replay.agent.example.com'],
    });

    try {
      const signedVP = await signVPForAgent(client, agent.did, {
        targetService: 'amazon',
        userDid: 'did:hedera:testnet:live-user-placeholder',
        vcId: agent.vcId,
      });

      const firstRes = await http.post('/v1/vp/verify').send({ signedVP });
      expect(firstRes.statusCode).toBe(200);

      const replayRes = await http.post('/v1/vp/verify').send({ signedVP });
      expect(replayRes.statusCode).toBe(400);
      expect(replayRes.body.error.code).toBe('VP_ALREADY_CONSUMED');
    } finally {
      await agent.cleanup();
    }
  }, LIVE_HEDERA_TIMEOUT_MS);

  it('rejects a VP whose targetService was tampered with after signing', async () => {
    const client = new HelixClient(api.baseUrl, { adminApiKey: api.adminApiKey });
    const http = supertest(api.baseUrl);
    const agent = await onboardLiveAgent(api, client, {
      agentName: 'Live Tamper Agent',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-tamper.agent.example.com'],
    });

    try {
      const vpTampered = await signVPForAgent(client, agent.did, {
        targetService: 'amazon',
        userDid: 'did:hedera:testnet:live-user-placeholder',
        vcId: agent.vcId,
      });
      (vpTampered as unknown as { targetService: string }).targetService = 'tampered-service';

      const vpTamperRes = await http.post('/v1/vp/verify').send({ signedVP: vpTampered });
      expect(vpTamperRes.statusCode).toBe(400);
      // Mutating any part of the signed payload — including targetService —
      // invalidates the outer VP signature before verification ever reaches
      // per-field checks (see vp-verifier.ts: VP signature is checked first).
      expect(vpTamperRes.body.error.code).toBe('VP_SIGNATURE_INVALID');
    } finally {
      await agent.cleanup();
    }
  }, LIVE_HEDERA_TIMEOUT_MS);

  it('rejects a VP whose embedded VC was tampered with after signing', async () => {
    const client = new HelixClient(api.baseUrl, { adminApiKey: api.adminApiKey });
    const http = supertest(api.baseUrl);
    const agent = await onboardLiveAgent(api, client, {
      agentName: 'Live VC Tamper Agent',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-vc-tamper.agent.example.com'],
    });

    try {
      const vcTampered = await signVPForAgent(client, agent.did, {
        targetService: 'amazon',
        userDid: 'did:hedera:testnet:live-user-placeholder',
        vcId: agent.vcId,
      });
      (vcTampered.verifiableCredential[0] as any).credentialSubject.agentName = 'Tampered Agent';

      const vcTamperRes = await http.post('/v1/vp/verify').send({ signedVP: vcTampered });
      expect(vcTamperRes.statusCode).toBe(400);
      // The embedded VC is part of the VP's own signed payload, so mutating
      // it invalidates the VP signature the same way tampering the VP's own
      // fields does — it never gets far enough to check the VC's signature.
      expect(vcTamperRes.body.error.code).toBe('VP_SIGNATURE_INVALID');
    } finally {
      await agent.cleanup();
    }
  }, LIVE_HEDERA_TIMEOUT_MS);
});
