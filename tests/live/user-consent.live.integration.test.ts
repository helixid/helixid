import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONSENT_REQUEST_TYP,
  CONSENT_WITHDRAWAL_TYP,
  EnvSigner,
  derivePublicKey,
  didKeyDocument,
  generateKeyPair,
  publicKeyBytesToJwk,
  signRequest,
  verifyDelegationHop,
  type DidResolver,
} from '@helixid/core';
import { LIVE_HEDERA_TIMEOUT_MS, onboardLiveAgent, resetLiveTestDatabase, startLiveApi, type LiveApi } from '../utils/liveApi.js';

// KYA-OS story L3-H on the open-source server: a self-custody service whose did:web helixid hosts asks a
// user's consent, the user approves on the consent page, the root hop is signed by the user's pairwise
// did:key (the one key helixid holds), and the service withdraws it under that key. The service's did:web
// is served by helixid itself, so this runs with LIVE_DID_METHOD=web.
describe.skipIf(process.env['LIVE_DID_METHOD'] !== 'web')('User consent (L3-H) live integration', () => {
  let api: LiveApi;

  beforeAll(async () => {
    await resetLiveTestDatabase();
    api = await startLiveApi();
  });

  afterAll(async () => {
    await api?.stop();
  });

  const json = async (path: string, init: RequestInit): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${api.baseUrl}${path}`, init);
    return { status: res.status, body: await res.json() };
  };
  const signed = (path: string, request: string) => json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }) });

  it('a consent approved on the page is signed by the user did:key and withdrawn under that key', async () => {
    const keys = generateKeyPair();
    const created = await json('/v1/services', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-api-key': api.adminApiKey },
      body: JSON.stringify({ name: 'live-consent-shop', domain: 'shop.example', requiredScopes: ['read:orders'], keyCustody: 'self', didHosting: 'helix', publicKeyJwk: publicKeyBytesToJwk(Buffer.from(derivePublicKey(keys.privateKey), 'hex')) }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const serviceDid = (created.body.did ?? created.body.service?.did) as string;
    const service = new EnvSigner({ did: serviceDid, envVar: 'K', env: { K: keys.privateKey } });
    const agent = await onboardLiveAgent(api, { agentName: 'Live Consent Agent', requestedScopes: ['read:orders'], requestedDomains: ['https://live-consent.agent.example.com'] });

    const grant = { validUntil: new Date(Date.now() + 3_600_000).toISOString(), credentialSubject: { invoker: agent.did, invocationTarget: serviceDid, parentCapability: serviceDid, allowedAction: ['read:orders'] } };
    const request = await signed('/v1/consent/requests', await signRequest({ serviceUserId: 'live-user', grant }, service, CONSENT_REQUEST_TYP, `${api.baseUrl}/v1/consent/requests`));
    expect(request.status, JSON.stringify(request.body)).toBe(201);

    const page = await fetch(`${api.baseUrl}/consent/${request.body.id}`);
    expect(page.status).toBe(200);
    const cookie = String(page.headers.get('set-cookie')).split(';')[0]!;
    const html = await page.text();
    const field = (name: string): string => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)![1]!;
    const approve = await fetch(`${api.baseUrl}/consent/${request.body.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ pageToken: field('pageToken'), grantDigest: field('grantDigest') }).toString(),
    });
    expect(approve.status).toBe(200);

    const result = (await json(`/v1/consent/requests/${request.body.id}`, {})).body as { status: string; consentId: string; hop: Record<string, any> };
    expect(result.status).toBe('approved');
    expect(result.hop.issuer).toMatch(/^did:key:z6Mk/);
    expect(await verifyDelegationHop(result.hop, (async (did: string) => didKeyDocument(did)) as unknown as DidResolver)).toMatchObject({ ok: true, invoker: agent.did });

    const withdrawn = await signed('/v1/consent/withdrawals', await signRequest({ consentId: result.consentId }, service, CONSENT_WITHDRAWAL_TYP, `${api.baseUrl}/v1/consent/withdrawals`));
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(withdrawn.body.revoked).toEqual([result.hop.id]);
  }, LIVE_HEDERA_TIMEOUT_MS);
});
