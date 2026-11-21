import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import type { SignedVC } from '@helixid/core';
import {
  LIVE_HEDERA_TIMEOUT_MS,
  onboardLiveAgent,
  resetLiveTestDatabase,
  enrollLiveService,
  signLiveVP,
  startLiveApi,
  type LiveAgent,
  type LiveApi,
} from '../utils/liveApi.js';

// Agent-to-agent delegation (a "sub-agent") — distinct from the consent-grant
// flow: here the delegator is itself an onboarded agent, delegating a subset
// of its own privilege scopes to another agent. Both are server-custody
// agents, so the delegated VC is signed with the delegator's custodial key
// via POST /v1/agents/:did/delegate (AgentService.delegateAuthority()).
describe('Agent Delegation Live Integration', () => {
  let api: LiveApi;

  beforeAll(async () => {
    await resetLiveTestDatabase();
    api = await startLiveApi();
  });

  afterAll(async () => {
    await api?.stop();
  });

  async function delegate(
    from: LiveAgent,
    body: { to: string; scopes: string[]; expiresIn: number; vcId?: string },
  ): Promise<supertest.Response> {
    return supertest(api.baseUrl)
      .post(`/v1/agents/${encodeURIComponent(from.did)}/delegate`)
      .set('x-admin-api-key', api.adminApiKey)
      .send(body);
  }

  it('lets a delegated sub-agent present a VP whose delegationChain shows the parent', async () => {
    const parent = await onboardLiveAgent(api, {
      agentName: 'Live Delegation Parent',
      requestedScopes: ['read:orders', 'write:orders'],
      requestedDomains: ['https://live-delegation-parent.agent.example.com'],
      maxDelegationDepth: 1,
    });
    const child = await onboardLiveAgent(api, {
      agentName: 'Live Delegation Child',
      requestedScopes: ['read:profile'],
      requestedDomains: ['https://live-delegation-child.agent.example.com'],
    });

    const delegateRes = await delegate(parent, { to: child.did, scopes: ['read:orders'], expiresIn: 3600 });
    expect(delegateRes.statusCode).toBe(200);
    const delegatedVC = delegateRes.body.delegatedVC as SignedVC;
    expect(delegatedVC.credentialSubject).toMatchObject({
      id: child.did,
      privilegeScopes: ['read:orders'],
      delegationDepth: 1,
    });

    // The child now holds two active credentials (its own onboarding VC and
    // the delegated one); the VP carries both, and the verifier takes the
    // union of their scopes.
    const service = await enrollLiveService(api);
    const signedVP = await signLiveVP(api, child.did, { targetService: service.did });
    const verifyRes = await supertest(api.baseUrl).post('/v1/vp/verify').send({ signedVP });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.body).toMatchObject({
      valid: true,
      agentDid: child.did,
      privilegeScopes: expect.arrayContaining(['read:orders']),
    });
    // The chain lists every credential in the VP — the child's own, the
    // parent's own, then the delegated one — so the delegated link is last.
    const chain = verifyRes.body.delegationChain as { issuer: string; subject: string; delegationDepth: number }[];
    expect(chain.map((link) => link.subject)).toEqual(expect.arrayContaining([parent.did, child.did]));
    expect(chain.at(-1)).toMatchObject({ issuer: parent.did, subject: child.did, delegationDepth: 1 });
  }, LIVE_HEDERA_TIMEOUT_MS);

  it("rejects delegation past the parent VC's maxDelegationDepth", async () => {
    const parent = await onboardLiveAgent(api, {
      agentName: 'Live Depth Parent',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-depth-parent.agent.example.com'],
      maxDelegationDepth: 1,
    });
    const child = await onboardLiveAgent(api, {
      agentName: 'Live Depth Child',
      requestedScopes: ['read:profile'],
      requestedDomains: ['https://live-depth-child.agent.example.com'],
    });
    const grandchild = await onboardLiveAgent(api, {
      agentName: 'Live Depth Grandchild',
      requestedScopes: ['read:profile'],
      requestedDomains: ['https://live-depth-grandchild.agent.example.com'],
    });

    const firstHop = await delegate(parent, { to: child.did, scopes: ['read:orders'], expiresIn: 3600 });
    expect(firstHop.statusCode).toBe(200);

    // The delegated VC sits at depth 1 of a max of 1 — no budget left.
    const secondHop = await delegate(child, {
      to: grandchild.did,
      scopes: ['read:orders'],
      expiresIn: 3600,
      vcId: firstHop.body.delegatedVC.id,
    });
    expect(secondHop.statusCode).toBe(400);
    expect(secondHop.body.error.code).toBe('MAX_DELEGATION_DEPTH_EXCEEDED');
  }, LIVE_HEDERA_TIMEOUT_MS);

  it('rejects delegating a scope the parent does not hold', async () => {
    const parent = await onboardLiveAgent(api, {
      agentName: 'Live Escalation Parent',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-escalation-parent.agent.example.com'],
      maxDelegationDepth: 1,
    });
    const child = await onboardLiveAgent(api, {
      agentName: 'Live Escalation Child',
      requestedScopes: ['read:profile'],
      requestedDomains: ['https://live-escalation-child.agent.example.com'],
    });

    const res = await delegate(parent, {
      to: child.did,
      scopes: ['write:orders'],
      expiresIn: 3600,
      vcId: parent.vcId,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('SCOPE_ESCALATION_DENIED');
  }, LIVE_HEDERA_TIMEOUT_MS);
});
