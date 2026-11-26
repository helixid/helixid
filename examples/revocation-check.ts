// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Revocation against renewal of an agent's identity credential, the one its
// card stands on (KYA-OS stories F-1 and L3-C):
//
//   1. setup: a service, a self-custody agent (`helix init`), its root hop,
//      and one accepted call;
//   2. revoke the identity credential (POST /v1/vcs/:id/revoke): helixid
//      flips its bit on the issuer's status list, with the agent's capability
//      attestations; the status reads `revoked`, and the next call is refused
//      `status_revoked` by the service, which reads the list live;
//   3. revocation is final: renewing the revoked credential is refused;
//   4. a replacement agent is enrolled and rooted, and its calls pass; the old
//      agent stays revoked;
//   5. the replacement's identity credential is renewed before it expires
//      (POST /v1/vcs/:id/renew): a new credential replaces the old one, and
//      its calls still pass.
//
// The service verifies through POST /v1/verify with live status reads and
// accepts only L3 (see request-proof.ts; self-verify.ts runs the same
// verifier in-process).
//
// Run: HELIX_ADMIN_API_KEY=... pnpm example:revocation-check
// (HELIX_API_URL defaults to http://localhost:3000.)

import {
  acceptable,
  call,
  createSelfCustodyAgent,
  createService,
  fail,
  finish,
  requireAdminKey,
  rootHop,
  runSuffix,
  show,
  signCall,
  type Agent,
  type Hop,
  type Verdict,
} from './kyaos-example-utils.js';

const SCOPE = 'read:catalog';

interface VcSummary {
  vcId: string;
  vcType: string;
  status: string;
}

/** The agent's active identity credential: what its card's revocation entry points at. */
async function identityOf(agentDid: string): Promise<VcSummary> {
  const vcs = await call<VcSummary[]>('GET', `/v1/vcs?subjectDid=${encodeURIComponent(agentDid)}&status=active`);
  const identity = vcs.find((vc) => vc.vcType === 'AgentIdentityCredential');
  if (!identity) throw new Error(`No active identity credential for ${agentDid}`);
  return identity;
}

const statusOf = async (vcId: string): Promise<string> => (await call<{ status: string }>('GET', `/v1/vcs/${encodeURIComponent(vcId)}/status`, undefined, false)).status;

async function main(): Promise<void> {
  requireAdminKey();
  const suffix = runSuffix();

  console.log('[1] setup: a service, a self-custody agent, its root hop...');
  const service = await createService(`catalog-${suffix}`, [SCOPE]);
  const agent = await createSelfCustodyAgent(`catalog-agent-${suffix}`, [SCOPE]);
  const chain: Hop[] = [await rootHop(agent.did, service.did, [SCOPE])];
  const callAs = async (who: Agent, whoseChain: Hop[]): Promise<Verdict> => {
    const signed = await signCall(who.signer, service.did, whoseChain);
    return call<Verdict>('POST', '/v1/verify', { proof: signed.proof, request: signed.request, chain: whoseChain, expectedAudience: service.did, action: SCOPE, liveStatus: true }, false);
  };
  const before = await callAs(agent, chain);
  show('a call', before);

  console.log('[2] revoking its identity credential...');
  const identity = await identityOf(agent.did);
  await call('POST', `/v1/vcs/${encodeURIComponent(identity.vcId)}/revoke`, {});
  const status = await statusOf(identity.vcId);
  console.log(`    status of ${identity.vcId}: ${status}`);
  const afterRevoke = await callAs(agent, chain);
  show('a call after the revocation', afterRevoke);

  console.log('[3] renewing the revoked credential...');
  let renewalRefused = false;
  try {
    await call('POST', `/v1/vcs/${encodeURIComponent(identity.vcId)}/renew`, {});
    console.log('    renewed (unexpected)');
  } catch (error) {
    renewalRefused = true;
    console.log(`    refused: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log('[4] enrolling a replacement agent...');
  const replacement = await createSelfCustodyAgent(`catalog-agent-${suffix}-2`, [SCOPE]);
  const replacementChain: Hop[] = [await rootHop(replacement.did, service.did, [SCOPE])];
  const replaced = await callAs(replacement, replacementChain);
  show('the replacement agent', replaced);
  const oldAgain = await callAs(agent, chain);
  show('the revoked agent, again', oldAgain);

  console.log("[5] renewing the replacement's identity credential before it expires...");
  const original = await identityOf(replacement.did);
  const renewed = await call<{ vcId: string; previousVcId: string }>('POST', `/v1/vcs/${encodeURIComponent(original.vcId)}/renew`, {});
  console.log(`    ${renewed.previousVcId} -> ${renewed.vcId}`);
  const afterRenew = await callAs(replacement, replacementChain);
  show('the replacement agent after the renewal', afterRenew);

  finish(
    acceptable(before) &&
      status === 'revoked' &&
      !acceptable(afterRevoke) && (afterRevoke.reasons ?? []).includes('status_revoked') &&
      renewalRefused &&
      acceptable(replaced) &&
      !acceptable(oldAgain) &&
      acceptable(afterRenew),
    'seven',
  );
}

main().catch(fail('revocation-check'));
