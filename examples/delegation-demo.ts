import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

import {
  HelixClient,
  MaxDelegationDepthExceededError,
  ScopeEscalationDeniedError,
} from '@helixid/sdk-js';

// Delegation demo, rewritten for server custody.
//
// Agent self-custody has been retired, so there is no local keypair, wallet
// file or passphrase anywhere in this demo. Both onboarding and delegation are
// API calls: onboardAgent() has the server generate and hold the agent's key,
// and delegateAuthority() authorizes HelixID to sign the delegation on the
// delegator's behalf. The SDK's wallet-based delegate() needed the delegator's
// own private key and so has had nothing legitimate to call since that sweep.
//
// Delegation-VC construction -- including the scope-subset and max-depth
// checks -- is server-side, as is the lookup of which credential to delegate
// from. Requires a running helix-api instance:
//
//   HELIX_API_URL=http://127.0.0.1:3579 \
//   HELIX_ADMIN_API_KEY=your-admin-key \
//   pnpm exec tsx examples/delegation-demo.ts
//
// The admin key is required: in OSS/core both signing routes
// (/v1/agents/:did/vp and /v1/agents/:did/delegate) are admin-key gated,
// because there is no per-tenant credential narrower than it. Minting the
// enrollment token is not gated.

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

const helixApiUrl = process.env.HELIX_API_URL ?? process.env.API_BASE_URL ?? 'http://localhost:3000';
const adminApiKey = process.env.HELIX_ADMIN_API_KEY;

async function createEnrollmentToken(input: {
  agentName: string;
  requestedScopes: string[];
  maxDelegationDepth: number;
}): Promise<string> {
  const response = await fetch(`${helixApiUrl}/v1/enrollment-tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agentName: input.agentName,
      requestedScopes: input.requestedScopes,
      requestedDomains: ['https://api.example.invalid'],
      maxDelegationDepth: input.maxDelegationDepth,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Enrollment token creation failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { token: string };
  return body.token;
}

async function onboardAgent(
  client: HelixClient,
  agentName: string,
  scopes: string[],
  maxDelegationDepth: number,
): Promise<{ agentDid: string; vcId: string }> {
  // Two API calls, deliberately: minting the enrollment token is an
  // agent-owner action (and is not exposed as an SDK method), while
  // onboardAgent() is the agent-side call that redeems it. Calling them
  // back to back here is the scripted equivalent of doing both in Console.
  const token = await createEnrollmentToken({ agentName, requestedScopes: scopes, maxDelegationDepth });
  return client.onboardAgent(token, ['https://api.example.invalid']);
}

async function main(): Promise<void> {
  console.log('=== HelixID Delegation Demo (helix-sdk-js) ===');
  console.log(`API: ${helixApiUrl}\n`);

  if (!adminApiKey) {
    throw new Error(
      'HELIX_ADMIN_API_KEY is required: delegateAuthority() hits the admin-key ' +
        'gated /v1/agents/:did/delegate route.',
    );
  }
  const client = new HelixClient(helixApiUrl, { adminApiKey });

  console.log('[Step 1] Onboard delegator agent (maxDelegationDepth=1, scopes: read:orders, write:orders)');
  const delegator = await onboardAgent(client, 'Delegator Agent', ['read:orders', 'write:orders'], 1);
  console.log(`  delegator DID: ${delegator.agentDid}`);
  console.log(`  delegator VC id: ${delegator.vcId}\n`);

  console.log('[Step 2] Onboard sub-agent (no delegation authority of its own)');
  const subAgent = await onboardAgent(client, 'Sub-Agent', [], 0);
  console.log(`  sub-agent DID: ${subAgent.agentDid}\n`);

  console.log("[Step 3] Delegator delegates 'read:orders' to sub-agent via delegateAuthority()");
  console.log('  (the server holds the delegator key and signs -- nothing is signed locally)');
  const delegatedVC = await client.delegateAuthority(
    delegator.agentDid,
    subAgent.agentDid,
    ['read:orders'],
    3600,
    { vcId: delegator.vcId },
  );
  // credentialSubject is a union across subject types (agent, user, ...);
  // a delegated VC is always the agent shape, so narrow it for logging.
  const delegatedSubject = delegatedVC.credentialSubject as {
    privilegeScopes?: string[];
    delegationDepth?: number;
  };
  console.log(`  sub-agent VC id: ${delegatedVC.id}`);
  console.log(`  delegated scopes: ${delegatedSubject.privilegeScopes?.join(', ')}`);
  console.log(`  delegationDepth: ${delegatedSubject.delegationDepth}\n`);

  console.log('[Step 4] Sub-agent attempts to delegate further (should be blocked -- it has no delegation authority)');
  try {
    // No vcId passed: the server resolves the sub-agent's own delegated
    // credential and finds it has no delegation budget left.
    await client.delegateAuthority(
      subAgent.agentDid,
      'did:key:z6MkSomeOtherAgentPlaceholder',
      ['read:orders'],
      3600,
    );
    console.error('  ERROR: unexpected success -- delegation should have been blocked');
    process.exitCode = 1;
    return;
  } catch (error: unknown) {
    // Live-verified (2026-09-01): an agent with zero remaining delegation
    // depth has an empty effective delegable-scope set, so the API reports
    // this as ScopeEscalationDeniedError rather than
    // MaxDelegationDepthExceededError. Either is an acceptable "delegation
    // blocked" outcome for this demo -- see the equivalent note in
    // helix-sdk-py's examples/agent_delegation_demo.py. Which one the API
    // *should* return for an exhausted-depth agent is tracked separately,
    // not fixed here.
    if (error instanceof MaxDelegationDepthExceededError || error instanceof ScopeEscalationDeniedError) {
      console.log(`  Expected failure: ${error.code} -- delegation blocked as designed`);
    } else {
      throw error;
    }
  }

  console.log('\n=== Demo complete ===');
}

main().catch((error: unknown) => {
  console.error('Fatal error in delegation demo:', error);
  process.exitCode = 1;
});
