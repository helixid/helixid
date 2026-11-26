// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Agent-to-agent delegation with self-custody agents (KYA-OS §6.10, story
// L3-D), with no LLM and no Docker. On helixid every agent holds its own key,
// so the delegating agent signs its hop itself; helixid only hosts the hop's
// status entry on the agent's own status list, which the agent signs too.
//
//   1. setup: a service offering two scopes, a planner agent and a research
//      agent (both `helix init`), and the planner's root hop over the service
//      for both scopes;
//   2. the planner delegates to the research agent, narrowed to one scope: an
//      entry on the planner's own status list (POST /v1/status-list/entries),
//      the hop signed with the planner's key (`reissueHop`), and the list
//      re-signed and published (PUT /v1/status-list/:id);
//   3. the research agent calls with the chain [root, hop]: accepted for the
//      scope it was given, refused (`action_not_delegated`) for the one the
//      planner kept;
//   4. a hop that asks for more than its parent holds is refused at
//      verification (attenuation: a hop may only narrow).
//
// TODO(Hop-Guard session): the delegation-depth ceiling (`maxDelegationDepth`
// on the agent, enforced when a hop is issued) is not shown here yet. KYA-OS
// hops do not enforce it today (flag D6); the Hop-Guard session adds the
// check, and then a step here: a hop past the ceiling, refused at issuance.
//
// The service verifies through POST /v1/verify with live status reads and
// accepts only L3 (see request-proof.ts).
//
// Run: HELIX_ADMIN_API_KEY=... pnpm example:delegation-demo
// (HELIX_API_URL defaults to http://localhost:3000.)

import { base58btcEncode, kyaos, reissueHop } from '@helixid/sdk-js';
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

const READ = 'read:catalog';
const WRITE = 'write:orders';

/** An eddsa-jcs-2022 Data Integrity proof by `signer`, the document's issuer: how a self-custody issuer signs its own status list. */
async function signDataIntegrity(document: Record<string, unknown>, signer: kyaos.Signer): Promise<Record<string, unknown>> {
  const unsecured = Object.fromEntries(Object.entries(document).filter(([key]) => key !== 'proof'));
  const proof = {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: new Date().toISOString(),
    verificationMethod: `${signer.did}#${signer.kid.replace(/^#/, '')}`,
    proofPurpose: 'assertionMethod',
  };
  const options = { ...proof, ...(unsecured['@context'] === undefined ? {} : { '@context': unsecured['@context'] }) };
  const signature = await signer.sign(kyaos.verifier.hashData(options, unsecured));
  return { ...unsecured, proof: { ...proof, proofValue: `z${base58btcEncode(signature)}` } };
}

/** The agent re-signs its own status list's current bits; helixid serves nothing for it until it has. */
async function publishOwnStatusList(agent: Agent, listId: string): Promise<void> {
  const unsigned = await call<Record<string, unknown>>('GET', `/v1/status-list/${listId}/unsigned`);
  await call('PUT', `/v1/status-list/${listId}`, await signDataIntegrity(unsigned, agent.signer));
}

/** `from` delegates to `invoker` under `parent`, signing the hop with its own key; the hop's status entry is on `from`'s own list. */
async function delegateHop(from: Agent, parent: Hop[], invoker: string, allowedAction: string[]): Promise<{ hop: Hop; listId: string }> {
  const leaf = parent[parent.length - 1]!;
  const entry = await call<{ statusListCredential: string; statusListIndex: string }>('POST', '/v1/status-list/entries', { issuer: from.did });
  const template = {
    '@context': leaf['@context'],
    type: ['VerifiableCredential', 'DelegationCredential'],
    issuer: from.did,
    validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    credentialSubject: { invoker, parentCapability: leaf.id, invocationTarget: leaf.credentialSubject.invocationTarget, allowedAction },
  };
  const hop = (await reissueHop(template, {
    signer: from.signer,
    statusEntry: { type: 'BitstringStatusListEntry', statusPurpose: 'revocation', statusListIndex: entry.statusListIndex, statusListCredential: entry.statusListCredential },
  })) as Hop;
  const listId = entry.statusListCredential.split('/').pop()!;
  await publishOwnStatusList(from, listId);
  return { hop, listId };
}

async function main(): Promise<void> {
  requireAdminKey();
  const suffix = runSuffix();

  console.log('[1] setup: a service, a planner and a research agent, the planner\'s root hop...');
  const service = await createService(`travel-${suffix}`, [READ, WRITE]);
  const planner = await createSelfCustodyAgent(`planner-${suffix}`, [READ, WRITE]);
  const research = await createSelfCustodyAgent(`research-${suffix}`, [READ, WRITE]);
  const root = await rootHop(planner.did, service.did, [READ, WRITE]);
  console.log(`    planner  ${planner.did}: root hop for [${READ}, ${WRITE}]`);
  console.log(`    research ${research.did}`);
  const callAs = async (agent: Agent, chain: Hop[], action: string): Promise<Verdict> => {
    const signed = await signCall(agent.signer, service.did, chain);
    return call<Verdict>('POST', '/v1/verify', { proof: signed.proof, request: signed.request, chain, expectedAudience: service.did, action, liveStatus: true }, false);
  };

  console.log(`[2] the planner delegates [${READ}] to the research agent, signing the hop itself...`);
  const { hop, listId } = await delegateHop(planner, [root], research.did, [READ]);
  const chain = [root, hop];
  console.log(`    hop ${hop.id}, its status on the planner's own list ${listId}`);

  console.log('[3] the research agent calls with the chain [root, hop]...');
  const delegated = await callAs(research, chain, READ);
  show(`for ${READ}`, delegated);
  const kept = await callAs(research, chain, WRITE);
  show(`for ${WRITE}, which the planner kept`, kept);

  console.log('[4] a hop asking for more than its parent holds...');
  const { hop: wider } = await delegateHop(planner, [root], research.did, [READ, 'delete:orders']);
  const widened = await callAs(research, [root, wider], READ);
  show('a call carrying the wider hop', widened);

  const refusedWith = (verdict: Verdict, reason: string): boolean => !acceptable(verdict) && (verdict.reasons ?? []).includes(reason);
  finish(
    acceptable(delegated) && refusedWith(kept, 'action_not_delegated') && refusedWith(widened, 'attenuation_violation'),
    'three',
  );
}

main().catch(fail('delegation-demo'));
