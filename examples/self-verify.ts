// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//    http://www.apache.org/licenses/LICENSE-2.0
//
// The service verifies every call itself, in-process, step by step (KYA-OS
// story F-2): no Helix API call decides anything. It reads the agent's DID
// document, card and status lists from where they are published, and runs
// `createLocalVerifier` from `@helixid/mcp-middleware`, the same verifier the
// MCP middleware puts in front of every tool. This is the KYA-OS default, not
// an alternative path.
//
//   1. setup: a service, a self-custody agent (`helix init`) and its root hop;
//   2. what the verifier reads: the DID document, the signing key in it, the
//      agent's card (its responsible party and attested capabilities);
//   3. one call verified: proof signature, audience, request hash, nonce,
//      card, each hop's signature and attenuation, live status, level;
//   4. each check shown refusing on purpose: a tampered request, a proof for
//      another service, a replay, an action the chain does not allow, a
//      cached status read (L2, below this service's L3), and a revoked hop.
//
// Run: HELIX_ADMIN_API_KEY=... pnpm example:self-verify
// (HELIX_API_URL defaults to http://localhost:3000; against a local helixid
// the verifier reads http on loopback.)

import { createLocalVerifier } from '@helixid/mcp-middleware';
import {
  API,
  call,
  cardOf,
  createSelfCustodyAgent,
  createService,
  fail,
  finish,
  requireAdminKey,
  rootHop,
  runSuffix,
  show,
  signCall,
  acceptable,
  type SignedCall,
  type Verdict,
} from './kyaos-example-utils.js';

const SCOPE = 'read:catalog';
const OTHER_SCOPE = 'write:orders';

async function main(): Promise<void> {
  requireAdminKey();
  const suffix = runSuffix();

  console.log('[1] setup: a service, a self-custody agent, its root hop...');
  const service = await createService(`catalog-${suffix}`, [SCOPE, OTHER_SCOPE]);
  const other = await createService(`elsewhere-${suffix}`, [SCOPE]);
  const agent = await createSelfCustodyAgent(`catalog-agent-${suffix}`, [SCOPE]);
  const chain = [await rootHop(agent.did, service.did, [SCOPE])];
  console.log(`    service ${service.did}\n    agent   ${agent.did}`);

  // The service's own verifier. Its only Helix-specific setting binds the
  // Helix issuer to the status list every hosted card names (keeper rule,
  // SPEC-ENTITY-CARD §10.3); everything else is read from public documents.
  const health = await call<{ issuerDid: string }>('GET', '/health', undefined, false);
  const verifier = createLocalVerifier({
    serviceDid: service.did,
    catalog: [SCOPE, OTHER_SCOPE],
    allowLoopbackHttp: true,
    statusListIssuers: { [health.issuerDid]: [`${API}/v1/status-list/helix-status-list-1`] },
    reportVerification: () => undefined,
  });
  type Result = Awaited<ReturnType<typeof verifier.verify>>;
  const verify = (signed: SignedCall, options: { action?: string; liveStatus?: boolean } = {}): Promise<Result> =>
    verifier.verify({ proof: signed.proof, chain, request: signed.request }, { action: SCOPE, liveStatus: true, ...options });

  console.log('[2] what the verifier reads, from where it is published...');
  const document = (await verifier.seams.resolveDid?.(agent.did)) as { verificationMethod?: { id: string }[] } | null;
  console.log(`    DID document: ${document ? `${document.verificationMethod?.length ?? 0} verification method(s)` : 'not found'}`);
  const keys = (await verifier.seams.resolveDidKeys?.(agent.did)) ?? [];
  console.log(`    signing keys the DID publishes: ${keys.length} (the proof's key must be one of them)`);
  const card = await cardOf(agent.did);
  const capabilities = (card['capabilities'] as { name: string }[] | undefined)?.map((c) => c.name) ?? [];
  console.log(`    card: responsible party ${card.responsibleParty}, attested [${capabilities.join(', ')}]`);

  console.log('[3] one call, every check run in-process...');
  const first = await signCall(agent.signer, service.did, chain);
  const accepted = await verify(first);
  show(`the call, for ${SCOPE}`, accepted);
  console.log(`    chain depth ${accepted.chainSummary.depth}, rooted by ${accepted.chainSummary.responsibleParty}; proof floor met: ${accepted.proofFloor}; status read live: ${accepted.fresh}`);

  console.log('[4] each check, refusing on purpose...');
  const tampered = await signCall(agent.signer, service.did, chain);
  const tamperedRequest = { ...tampered.request, params: { ...tampered.request.params, arguments: { q: 'everything' } } };
  const hashCheck = await verify({ proof: tampered.proof, request: tamperedRequest });
  show('request hash: the arguments changed after signing', hashCheck);
  const audienceCheck = await verify(await signCall(agent.signer, other.did, chain));
  show('audience: a proof signed for another service', audienceCheck);
  const replayCheck = await verify(first);
  show('nonce: the first proof sent again', replayCheck);
  const actionCheck = await verify(await signCall(agent.signer, service.did, chain), { action: OTHER_SCOPE });
  show(`attenuation: asking for ${OTHER_SCOPE}, which the chain does not allow`, actionCheck);
  await verify(await signCall(agent.signer, service.did, chain), { liveStatus: false }); // warms the status cache
  const cachedCheck = await verify(await signCall(agent.signer, service.did, chain), { liveStatus: false });
  show('status: read from the cache, not live', cachedCheck);
  await call('POST', `/v1/vcs/${encodeURIComponent(chain[0]!.id)}/revoke`, {});
  const revokedCheck = await verify(await signCall(agent.signer, service.did, chain));
  show('status: a call after the root hop was revoked (read live)', revokedCheck);

  const refusedWith = (verdict: Verdict, reason: string): boolean => !acceptable(verdict) && (verdict.reasons ?? []).includes(reason);
  finish(
    acceptable(accepted) &&
      refusedWith(hashCheck, 'request_hash_mismatch') &&
      refusedWith(audienceCheck, 'audience_mismatch') &&
      refusedWith(replayCheck, 'nonce_replayed') &&
      refusedWith(actionCheck, 'action_not_delegated') &&
      cachedCheck.ok && cachedCheck.level === 'L2' &&
      refusedWith(revokedCheck, 'status_revoked'),
    'seven',
  );
}

main().catch(fail('self-verify'));
