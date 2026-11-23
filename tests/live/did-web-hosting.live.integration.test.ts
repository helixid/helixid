// One did:web shape (2026-11-23): helixid serves the did:web it mints at
// /agents/<hex>/did.json and card.json, and its issuer at
// /.well-known/did.json only when the issuer is this domain's did:web.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { onboardLiveAgent, resetLiveTestDatabase, startLiveApi, type LiveApi } from '../utils/liveApi.js';

describe('did:web hosting (live)', () => {
  let api: LiveApi;

  beforeAll(async () => {
    await resetLiveTestDatabase();
    api = await startLiveApi();
  });

  afterAll(async () => {
    await api?.stop();
  });

  it('serves the agent did:web and card at /agents/<hex>/, and the issuer only when it is a did:web', async () => {
    const agent = await onboardLiveAgent(api, { agentName: 'Hosted Agent', requestedScopes: ['read:orders'], requestedDomains: ['https://hosted.agent.example.com'] });
    const issuer = await fetch(`${api.baseUrl}/.well-known/did.json`);
    if (!agent.did.startsWith('did:web:')) {
      expect(issuer.status, 'a did:key issuer claims no did:web id').toBe(404);
      return; // the did:web assertions below run with LIVE_DID_METHOD=web
    }
    expect(agent.did).toMatch(/^did:web:127\.0\.0\.1%3A\d+:agents:[0-9a-f]{32}$/);
    expect(((await issuer.json()) as { id: string }).id, 'the issuer is did:web:<domain>').toBe(agent.did.split(':').slice(0, 3).join(':'));
    const hex = agent.did.split(':').pop();
    const document = (await (await fetch(`${api.baseUrl}/agents/${hex}/did.json`)).json()) as { id: string; service: { type: string; serviceEndpoint: string }[] };
    expect(document.id).toBe(agent.did);
    const cardUrl = document.service.find((entry) => entry.type === 'KyaOsEntityCard')?.serviceEndpoint;
    expect(cardUrl).toBe(`${api.baseUrl}/agents/${hex}/card.json`.replace('localhost', '127.0.0.1'));
    const card = (await (await fetch(`${api.baseUrl}/agents/${hex}/card.json`)).json()) as { id: string; entityType: string };
    expect(card).toMatchObject({ id: agent.did, entityType: 'agent' });
  });
});
