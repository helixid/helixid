import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { HelixClient } from '@helixid/sdk-js';
import {
  LIVE_HEDERA_TIMEOUT_MS,
  signVPForAgent,
  onboardLiveAgent,
  resetLiveTestDatabase,
  startLiveApi,
  type LiveApi,
} from '../utils/liveApi.js';

// Agent-to-agent delegation (a "sub-agent") — distinct from the consent-grant
// flow: here the delegator is itself an onboarded agent, delegating a subset
// of its own privilege scopes to another agent it controls, via the SDK's
// server-held key: delegateAuthority() has the server sign on the delegator's
// behalf. Agent self-custody is retired, so the SDK's wallet-based delegate()
// — which needed the delegator's private key locally — has had nothing
// legitimate to call since.
describe('Agent Delegation Live Integration', () => {
  let api: LiveApi;

  beforeAll(async () => {
    await resetLiveTestDatabase();
    api = await startLiveApi();
  });

  afterAll(async () => {
    await api?.stop();
  });

  it('lets a delegated sub-agent present a VP whose delegationChain shows the parent', async () => {
    const client = new HelixClient(api.baseUrl, { adminApiKey: api.adminApiKey });
    const http = supertest(api.baseUrl);
    const delegator = await onboardLiveAgent(api, client, {
      agentName: 'Live Delegator Agent',
      requestedScopes: ['read:orders', 'write:orders'],
      requestedDomains: ['https://live-delegator.agent.example.com'],
      maxDelegationDepth: 1,
    });

    // The sub-agent is onboarded the same way: under server custody there is
    // no such thing as an agent whose key exists only locally.
    const subAgent = await onboardLiveAgent(api, client, {
      agentName: 'Live Sub-Agent',
      requestedScopes: [],
      requestedDomains: ['https://live-subagent.agent.example.com'],
    });

    try {
      const subAgentVC = await client.delegateAuthority(
        delegator.did,
        subAgent.did,
        ['read:orders'],
        3600,
        { vcId: delegator.vcId },
      );

      // The sub-agent now holds two active agent credentials — its own
      // onboarding VC and this delegated one — so the VP pins which to present.
      const signedVP = await signVPForAgent(client, subAgent.did, {
        targetService: 'amazon',
        userDid: 'did:hedera:testnet:live-user-placeholder',
        vcId: subAgentVC.id,
      });

      const verifyRes = await http.post('/v1/vp/verify').send({ signedVP });
      expect(verifyRes.statusCode).toBe(200);
      expect(verifyRes.body).toMatchObject({
        valid: true,
        agentDid: subAgent.did,
        privilegeScopes: ['read:orders'],
        effectiveScopes: ['read:orders'],
      });
      expect(verifyRes.body.delegationChain).toHaveLength(2);
      expect(verifyRes.body.delegationChain[0]).toMatchObject({ subject: delegator.did });
      expect(verifyRes.body.delegationChain[1]).toMatchObject({ subject: subAgent.did });
    } finally {
      await delegator.cleanup();
      await subAgent.cleanup();
    }
  }, LIVE_HEDERA_TIMEOUT_MS);

  it('rejects delegation past the parent VC\'s maxDelegationDepth', async () => {
    const client = new HelixClient(api.baseUrl, { adminApiKey: api.adminApiKey });
    const http = supertest(api.baseUrl);
    // maxDelegationDepth defaults to 0 unless requested — a fresh onboarded
    // agent (no explicit depth) cannot delegate at all.
    const delegator = await onboardLiveAgent(api, client, {
      agentName: 'Live No-Delegation Agent',
      requestedScopes: ['read:orders'],
      requestedDomains: ['https://live-no-delegation.agent.example.com'],
    });

    const subAgent = await onboardLiveAgent(api, client, {
      agentName: 'Live Reject Sub-Agent',
      requestedScopes: [],
      requestedDomains: ['https://live-reject-subagent.agent.example.com'],
    });

    try {
      await expect(
        client.delegateAuthority(delegator.did, subAgent.did, ['read:orders'], 3600, {
          vcId: delegator.vcId,
        }),
      ).rejects.toMatchObject({ code: 'MAX_DELEGATION_DEPTH_EXCEEDED' });
    } finally {
      await delegator.cleanup();
      await subAgent.cleanup();
    }
  }, LIVE_HEDERA_TIMEOUT_MS);
});
