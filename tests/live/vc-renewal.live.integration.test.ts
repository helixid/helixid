import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { HelixClient } from '@helixid/sdk-js';
import {
  LIVE_HEDERA_TIMEOUT_MS,
  onboardLiveAgent,
  resetLiveTestDatabase,
  startLiveApi,
  type LiveApi,
} from '../utils/liveApi.js';

// Renewal here is HelixClient.renewVC() on the agent's identity credential
// (F-1): the hosted issuer re-signs the same agent, name and responsible
// party with a fresh id and validity. Scopes live in capability
// attestations and are not part of renewal.
describe('VC Renewal Live Integration', () => {
  let api: LiveApi;

  beforeAll(async () => {
    await resetLiveTestDatabase();
    api = await startLiveApi();
  });

  afterAll(async () => {
    await api?.stop();
  });

  it('issues a fresh identity credential on renewal and links it back to the one it replaces', async () => {
    const client = new HelixClient(api.baseUrl, { adminApiKey: api.adminApiKey });
    const http = supertest(api.baseUrl);
    const agent = await onboardLiveAgent(api, {
      agentName: 'Live Renewal Agent',
      requestedScopes: ['read:orders', 'write:orders'],
      requestedDomains: ['https://live-renewal.agent.example.com'],
    });

    const renewed = await client.renewVC(agent.vcId, {});

    expect(renewed.vcId).not.toBe(agent.vcId);
    expect(renewed.vcId).toMatch(/^urn:uuid:/);
    const renewedVc = renewed.vc as Record<string, unknown>;
    expect(renewedVc['type']).toEqual(expect.arrayContaining(['VerifiableCredential', 'AgentIdentityCredential']));
    expect(renewedVc['issuer']).toBe(api.issuerDid);
    expect(renewedVc['credentialSubject']).toMatchObject({
      id: agent.did,
      name: 'Live Renewal Agent',
      responsibleParty: api.issuerDid,
    });

    const oldVcDetails = await client.getVC(agent.vcId);
    expect(oldVcDetails.renewedByVcId).toBe(renewed.vcId);
    // Renewal does not revoke the old identity credential: a separate lineage.
    expect(oldVcDetails.status).toBe('active');

    // Helix keeps a copy: the listing now leads with the renewed identity, attestations untouched.
    const credentialsRes = await http
      .get(`/v1/agents/${encodeURIComponent(agent.did)}/credentials`)
      .set('x-admin-api-key', api.adminApiKey);
    expect(credentialsRes.statusCode).toBe(200);
    expect(credentialsRes.body.identity.vcId).toBe(renewed.vcId);
    const attested = (credentialsRes.body.attestations as Array<{ credential: { credentialSubject: { capability: string } } }>)
      .map((entry) => entry.credential.credentialSubject.capability)
      .sort();
    expect(attested).toEqual(['read:orders', 'write:orders']);
  }, LIVE_HEDERA_TIMEOUT_MS);

  it('rejects renewing an already-revoked identity credential', async () => {
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
