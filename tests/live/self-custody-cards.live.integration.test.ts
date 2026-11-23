import { generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrollmentProofMessage } from '@helixid/core';
import { resetLiveTestDatabase, startLiveApi, type LiveApi } from '../utils/liveApi.js';

// helixid hosts agents' DID documents and Entity Cards (KYA-OS stories F-3
// and C-A), self-custody only: the agent generates and keeps its key, as
// `helix init` does; Helix registers the public JWK, publishes the documents
// under its domain, and refuses anything that would need it to hold a key.
describe('Self-custody onboarding and hosted cards Live Integration', () => {
  let api: LiveApi;
  const ownerDid = 'did:web:owner.example';

  // Helix hosting needs a domain to mint did:webs under. The did:key runs
  // configure none, so give this server one; documents are read back by path.
  const configuredDomain = process.env['DID_DOMAIN'];

  beforeAll(async () => {
    await resetLiveTestDatabase();
    process.env['DID_DOMAIN'] ??= 'helixid.live.test';
    api = await startLiveApi();
  }, 60_000);

  afterAll(async () => {
    await api?.stop();
    if (configuredDomain === undefined) delete process.env['DID_DOMAIN'];
  });

  async function call(method: string, path: string, body?: unknown, admin = true): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${api.baseUrl}${path}`, {
      method,
      headers: { ...(admin ? { 'x-admin-api-key': api.adminApiKey } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  /** The document Helix serves for a hosted URL, read from this server whatever host the URL names. */
  async function hosted(url: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    return call('GET', new URL(String(url)).pathname, undefined, false);
  }

  it('enrolls a self-custody agent with only its public key, then serves its DID document and a card with attestations, responsible party and revocation', async () => {
    const created = await call('POST', '/v1/agents', { name: `Self Agent ${Date.now()}`, scopes: ['orders:read'], ownerDid, keyCustody: 'self' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ keyCustody: 'self', didHosting: 'helix', status: 'pending_key' });
    const enrollmentToken = created.body['enrollmentToken'] as string;
    expect(enrollmentToken).toMatch(/^enroll:/);

    // helix init, step 1: the DID, kid and nonce, authorised by the token alone.
    const challenge = await call('POST', '/v1/agents/enroll/challenge', { enrollmentToken }, false);
    expect(challenge.status, JSON.stringify(challenge.body)).toBe(200);
    const { did, kid, nonce } = challenge.body as { did: string; kid: string; nonce: string };
    expect(did).toBe(created.body['did']);

    // The key is generated here, on the agent's side; only the public JWK leaves.
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const { kty, crv, x } = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string };
    const signature = sign(null, enrollmentProofMessage({ did, kid, nonce }), privateKey).toString('base64url');

    // Private material anywhere in the body is refused at the door.
    const leaked = await call('POST', '/v1/agents/enroll', { enrollmentToken, publicKeyJwk: { kty, crv, x, d: 'secret' }, signature }, false);
    expect(leaked.status).toBe(400);

    // helix init, step 2.
    const enrolled = await call('POST', '/v1/agents/enroll', { enrollmentToken, publicKeyJwk: { kty, crv, x }, signature }, false);
    expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
    expect(enrolled.body).toMatchObject({ did, keyCustody: 'self', didHosting: 'helix', status: 'active' });

    const document = await hosted(challenge.body['didDocumentUrl']);
    expect(document.status, JSON.stringify(document.body)).toBe(200);
    expect(document.body['id']).toBe(did);
    expect(JSON.stringify(document.body['verificationMethod'])).toContain(x);
    expect(JSON.stringify(document.body['service'])).toContain('KyaOsEntityCard');

    const card = await hosted(challenge.body['cardUrl']);
    expect(card.status, JSON.stringify(card.body)).toBe(200);
    expect(card.body['id']).toBe(did);
    expect(card.body['responsibleParty']).toBe(ownerDid);
    expect(card.body['revocation']).toBeDefined();
    const capabilities = card.body['capabilities'] as { name: string; attestations: { vc: { type: string[] } }[] }[];
    const ordersRead = capabilities.find((entry) => entry.name === 'orders:read');
    expect(ordersRead?.attestations.length).toBeGreaterThan(0);
    expect(ordersRead?.attestations[0]?.vc.type).toContain('CapabilityAttestationCredential');

    // The conformance report counts it as a self-custody agent.
    const report = await call('GET', '/v1/conformance/report');
    expect(report.status).toBe(200);
    expect(JSON.stringify(report.body['claimSet'])).toContain(did);

    // No custodial signing for it, or for anyone.
    const signed = await call('POST', `/v1/agents/${encodeURIComponent(did)}/sign`, { payload: 'AQ' });
    expect(signed.status).toBe(400);
    expect(signed.body).toMatchObject({ error: { code: 'CUSTODY_HELIX_UNAVAILABLE' } });
  });

  it("refuses keyCustody 'helix' clearly, and creates nothing", async () => {
    const refused = await call('POST', '/v1/agents', { name: 'Custodial Agent', keyCustody: 'helix' });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: { code: 'CUSTODY_HELIX_UNAVAILABLE', message: expect.stringContaining('self-custody only') } });
    const owner = await call('POST', '/v1/owners', { name: 'Custodial Owner', keyCustody: 'helix' });
    expect(owner.status).toBe(400);
    const report = await call('GET', '/v1/conformance/report');
    expect(JSON.stringify(report.body)).not.toContain('Custodial Agent');
  });

  it('mounts the host card route at /.well-known/kya-os-card.json for its own domain', async () => {
    // The host's card is served once its did:web has a DID record (story C-A);
    // either way the route answers for did:web:<DID_DOMAIN>, not the 404 of an unknown path.
    const card = await call('GET', '/.well-known/kya-os-card.json', undefined, false);
    if (card.status === 200) {
      expect(String(card.body['id'])).toMatch(/^did:web:/);
    } else {
      expect(card.status, JSON.stringify(card.body)).toBe(404);
      expect(card.body).toMatchObject({ error: { code: 'DID_NOT_FOUND', message: expect.stringMatching(/did:web:/) } });
    }
  });
});
