import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import {
  LIVE_HEDERA_TIMEOUT_MS,
  enrollLiveService,
  issueLiveGrant,
  onboardLiveAgent,
  resetLiveTestDatabase,
  startLiveApi,
  type LiveApi,
} from '../utils/liveApi.js';

// Consent end to end (story F-1): a service issues a DelegationGrantCredential
// to an agent for a user. Since F-1 an agent holds an AgentIdentityCredential
// and one CapabilityAttestationCredential per scope, so the scopes a grant may
// carry are the agent's active attestations, and the agent must still hold an
// active identity credential.
describe('Service Delegation Grant Live Integration', () => {
  let api: LiveApi;
  const userDid = 'did:web:mock.local:users:alice';

  beforeAll(async () => {
    await resetLiveTestDatabase();
    api = await startLiveApi();
  });

  afterAll(async () => {
    await api?.stop();
  });

  function agentScopes(serviceDid: string, agentDid: string): supertest.Test {
    return supertest(api.baseUrl)
      .get('/v1/service-delegation-grants/agent-scopes')
      .query({ serviceDid, agentDid })
      .set('x-admin-api-key', api.adminApiKey);
  }

  function grant(serviceDid: string, agentDid: string, scopes: string[]): supertest.Test {
    return supertest(api.baseUrl)
      .post('/v1/service-delegation-grants')
      .set('x-admin-api-key', api.adminApiKey)
      .send({ serviceDid, agentDid, userDid, scopes, durability: 'standing' });
  }

  it('issues a grant bounded by the agent\'s capability attestations, and follows their revocation', async () => {
    const agent = await onboardLiveAgent(api, {
      agentName: 'Live Grant Agent',
      requestedScopes: ['read:orders', 'write:orders'],
      requestedDomains: ['https://live-grant.agent.example.com'],
    });
    const service = await enrollLiveService(api, 'grantshop');

    // The consent screen's offer: the agent's attested capabilities.
    const scopesRes = await agentScopes(service.did, agent.did);
    expect(scopesRes.statusCode).toBe(200);
    expect(scopesRes.body.agentDid).toBe(agent.did);
    expect([...scopesRes.body.scopes].sort()).toEqual(['read:orders', 'write:orders']);

    // A grant within those capabilities is issued, signed by the service.
    const grantVC = await issueLiveGrant(api, { serviceDid: service.did, agentDid: agent.did, userDid, scopes: ['read:orders'] });
    expect(grantVC.issuer).toBe(service.did);
    expect(grantVC.type).toEqual(expect.arrayContaining(['VerifiableCredential', 'DelegationGrantCredential']));
    expect(grantVC.credentialSubject).toMatchObject({ id: agent.did, userDid, scopes: ['read:orders'] });

    // A scope the agent holds no attestation for is refused, by name.
    const broad = await grant(service.did, agent.did, ['read:orders', 'admin:all']);
    expect(broad.statusCode).toBe(400);
    expect(broad.body.error.code).toBe('CONSENT_GRANT_SCOPE_NOT_ALLOWED');
    expect(broad.body.error.message).toContain('admin:all');

    // Revoking one attestation drops that scope, and only that one.
    const revoked = await supertest(api.baseUrl)
      .delete(`/v1/agents/${encodeURIComponent(agent.did)}/attestations/write:orders`)
      .set('x-admin-api-key', api.adminApiKey);
    expect(revoked.statusCode).toBe(200);
    expect((await agentScopes(service.did, agent.did)).body.scopes).toEqual(['read:orders']);
    const afterRevoke = await grant(service.did, agent.did, ['write:orders']);
    expect(afterRevoke.statusCode).toBe(400);
    expect(afterRevoke.body.error.code).toBe('CONSENT_GRANT_SCOPE_NOT_ALLOWED');
    expect((await grant(service.did, agent.did, ['read:orders'])).statusCode).toBe(201);

    // Revoking the identity credential leaves the agent with nothing a grant can rest on.
    const identityRevoked = await supertest(api.baseUrl)
      .post(`/v1/vcs/${encodeURIComponent(agent.vcId)}/revoke`)
      .set('x-admin-api-key', api.adminApiKey)
      .send({});
    expect(identityRevoked.statusCode).toBe(200);
    const noIdentity = await agentScopes(service.did, agent.did);
    expect(noIdentity.statusCode).toBe(404);
    expect(noIdentity.body.error.code).toBe('AGENT_ACTIVE_CREDENTIAL_NOT_FOUND');
    const refused = await grant(service.did, agent.did, ['read:orders']);
    expect(refused.statusCode).toBe(404);
    expect(refused.body.error.code).toBe('AGENT_ACTIVE_CREDENTIAL_NOT_FOUND');
  }, LIVE_HEDERA_TIMEOUT_MS);
});
