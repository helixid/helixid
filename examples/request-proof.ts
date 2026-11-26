// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//    http://www.apache.org/licenses/LICENSE-2.0
//
// KYA-OS end to end against a local helixid, with no LLM and no Docker:
//
//   1. register a service (POST /v1/services, admin key);
//   2. create a self-custody agent (POST /v1/agents, story F-3) and run
//      `helix init` for it: the agent's key is generated here and only its
//      public half reaches helixid, which publishes the DID document and card;
//   3. root the agent's authority over the service (POST /v1/grants): one
//      delegation hop (§6.10), the agent's delegation chain;
//   4. the agent signs a request proof for one tool call with its own key
//      (story C-C), carrying the chain;
//   5. the service verifies it locally through POST /v1/verify (story F-2)
//      with KYA-OS's default policy, L3: it asks for live status reads
//      (`liveStatus`; a verdict from cached lists is at most L2) and accepts
//      only a verdict at L3. Accepted, with the effective scopes; then the
//      refusals a verifier must make: an action the chain does not allow and
//      the same proof again (replay);
//   6. cached against live status: the same kind of call verified once from
//      the verifier's status cache (no `liveStatus`: at most L2) and once with
//      a live read (L3), each with a fresh proof; the L3 policy refuses the
//      cached verdict and accepts the live one;
//   7. a call made after the root hop was revoked (story L3-C: status_revoked).
//
// The other KYA-OS scripts: self-verify.ts (the same checks in-process, step
// by step), revocation-check.ts (the identity credential revoked and renewed)
// and delegation-demo.ts (an agent-to-agent hop).
//
// Run: HELIX_ADMIN_API_KEY=... pnpm example:request-proof
// (HELIX_API_URL defaults to http://localhost:3000; outside production helixid
// reads DID documents and status lists over http on loopback.)

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
  type SignedCall,
  type Verdict,
} from './kyaos-example-utils.js';

const SCOPE = 'read:catalog';
const OTHER_SCOPE = 'write:orders';

async function main(): Promise<void> {
  requireAdminKey();
  const suffix = runSuffix();

  console.log('[1] registering a service...');
  const service = await createService(`catalog-${suffix}`, [SCOPE, OTHER_SCOPE]);
  console.log(`    service ${service.did}`);

  console.log('[2] creating a self-custody agent and running helix init for it...');
  const agent = await createSelfCustodyAgent(`catalog-agent-${suffix}`, [SCOPE]);
  console.log(`    agent ${agent.did} (#${agent.kid}); key in ${agent.signingKeyFile}, never sent`);

  console.log("[3] rooting the agent's authority over the service...");
  const root = await rootHop(agent.did, service.did, [SCOPE]);
  const chain = [root];
  console.log(`    root hop ${root.id} issued by ${root.issuer}`);

  console.log('[4] the agent signs a request proof with its own key...');
  const sign = (): Promise<SignedCall> => signCall(agent.signer, service.did, chain);
  const verify = (signed: SignedCall, action: string, liveStatus = true): Promise<Verdict> =>
    call<Verdict>('POST', '/v1/verify', { proof: signed.proof, request: signed.request, chain, expectedAudience: service.did, action, ...(liveStatus ? { liveStatus } : {}) }, false);

  console.log('[5] the service verifies it locally (POST /v1/verify)...');
  const first = await sign();
  const accepted = await verify(first, SCOPE);
  show(`the call, for ${SCOPE}`, accepted);
  const outOfScope = await verify(await sign(), OTHER_SCOPE);
  show(`the same agent asking for ${OTHER_SCOPE}`, outOfScope);
  const replay = await verify(first, SCOPE);
  show('the first proof sent again', replay);

  console.log('[6] cached against live status, a fresh proof each time...');
  await verify(await sign(), SCOPE, false); // fills the verifier's status cache, if this is its first read
  const cached = await verify(await sign(), SCOPE, false);
  show('from the status cache (no liveStatus)', cached);
  const live = await verify(await sign(), SCOPE);
  show('with a live status read (liveStatus: true)', live);
  console.log(`    levels: cached ${cached.level}, live ${live.level}`);

  console.log('[7] revoking the root hop...');
  await call('POST', `/v1/vcs/${encodeURIComponent(root.id)}/revoke`, {});
  const afterRevoke = await verify(await sign(), SCOPE);
  show('a new call after the root hop was revoked', afterRevoke);

  finish(
    acceptable(accepted) &&
      !acceptable(outOfScope) &&
      !acceptable(replay) &&
      cached.ok && cached.level === 'L2' && !acceptable(cached) &&
      acceptable(live) &&
      !acceptable(afterRevoke),
    'six',
  );
}

main().catch(fail('request-proof'));
