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
//      refusals a verifier must make: an action the chain does not allow, the
//      same proof again (replay), and a call made after the root hop was
//      revoked (story L3-C: status_revoked).
//
// It replaces the VP-era scripts (verify-vp*, self-verify, scope-check,
// revocation-check, verifier-*), which used /v1/vp/verify and signVP; both
// are retired with no backward compatibility.
//
// Run: HELIX_ADMIN_API_KEY=... pnpm example:request-proof
// (HELIX_API_URL defaults to http://localhost:3000; outside production helixid
// reads DID documents and status lists over http on loopback.)

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { helixInit, kyaos } from '@helixid/sdk-js';

const API = (process.env.HELIX_API_URL ?? process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const ADMIN_API_KEY = process.env.HELIX_ADMIN_API_KEY;
const SCOPE = 'read:catalog';
const OTHER_SCOPE = 'write:orders';

interface Hop {
  id: string;
  issuer: string;
}

interface Verdict {
  ok: boolean;
  level?: string;
  agentDid?: string;
  effectiveScopes?: string[];
  reasons?: string[];
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, admin = true): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(admin ? { 'x-admin-api-key': ADMIN_API_KEY ?? '' } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await response.json().catch(() => ({}))) as T & { error?: { code?: string; message?: string } };
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${json.error?.code ?? ''} ${json.error?.message ?? ''}`.trim());
  return json;
}

/** The path of a Helix-hosted DID's card: `did:web:<host>:agents:<hex>` -> `/agents/<hex>/card.json`. */
function cardPath(did: string): string {
  return `/${did.split(':').slice(3).map(decodeURIComponent).join('/')}/card.json`;
}

/** `NAME=value` lines of the signing-key file `helix init` wrote, comments skipped. */
function envFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) env[match[1]!] = match[2]!;
  }
  return env;
}

/** The service's policy: the KYA-OS default minimum, L3 (a fresh status read). */
const acceptable = (verdict: Verdict): boolean => verdict.ok && verdict.level === 'L3';

function show(label: string, verdict: Verdict): void {
  const detail = verdict.ok
    ? `verified at ${verdict.level}${verdict.level === 'L3' ? '' : ' (not fresh: below the L3 this service requires)'}, scopes [${(verdict.effectiveScopes ?? []).join(', ')}]`
    : `${(verdict.reasons ?? []).join(', ')}`;
  console.log(`  ${label}: ${acceptable(verdict) ? 'accepted' : 'refused'} (${detail})`);
}

async function main(): Promise<void> {
  if (!ADMIN_API_KEY) throw new Error('Set HELIX_ADMIN_API_KEY to the API admin key (the same value the API runs with).');
  const suffix = Date.now().toString(36);

  console.log('[1] registering a service...');
  const service = await call<{ did: string }>('POST', '/v1/services', { name: `catalog-${suffix}`, domain: `catalog-${suffix}.example.com`, requiredScopes: [SCOPE, OTHER_SCOPE] });
  console.log(`    service ${service.did}`);

  console.log('[2] creating a self-custody agent and running helix init for it...');
  const created = await call<{ did: string; enrollmentToken: string }>('POST', '/v1/agents', { name: `catalog-agent-${suffix}`, scopes: [SCOPE], keyCustody: 'self', didHosting: 'helix' });
  const outDir = await mkdtemp(join(tmpdir(), 'helix-agent-'));
  const init = await helixInit({ apiUrl: API, enrollmentToken: created.enrollmentToken, outDir });
  console.log(`    agent ${init.did} (${init.kid}); key in ${init.files.signingKey}, never sent`);

  console.log("[3] rooting the agent's authority over the service...");
  const card = await call<{ responsibleParty?: string }>('GET', cardPath(init.did), undefined, false);
  const root = await call<{ hop: Hop }>('POST', '/v1/grants', { issuer: card.responsibleParty, invoker: init.did, invocationTarget: service.did, allowedAction: [SCOPE] });
  const chain = [root.hop];
  console.log(`    root hop ${root.hop.id} issued by ${root.hop.issuer}`);

  console.log("[4] the agent signs a request proof with its own key...");
  const signer = new kyaos.EnvSigner({ did: init.did, kid: init.kid.slice(init.kid.indexOf('#') + 1), env: envFile(await readFile(init.files.signingKey, 'utf8')) });
  interface Signed {
    request: unknown;
    proof: unknown;
  }
  const sign = async (): Promise<Signed> => {
    const request = { method: 'tools/call', params: { name: 'search_catalog', arguments: { q: 'shoes' } } };
    const signed = (await kyaos.withRequestProof(request, signer, { audience: service.did, chain })) as { params: { _meta: Record<string, unknown> } };
    return { request, proof: signed.params._meta['org.kya-os/request-proof'] };
  };
  const verify = (signed: Signed, extra: Record<string, unknown> = {}): Promise<Verdict> =>
    call<Verdict>('POST', '/v1/verify', { proof: signed.proof, request: signed.request, chain, expectedAudience: service.did, liveStatus: true, ...extra }, false);

  console.log('[5] the service verifies it locally (POST /v1/verify)...');
  const first = await sign();
  const accepted = await verify(first, { action: SCOPE });
  show(`the call, for ${SCOPE}`, accepted);
  const outOfScope = await verify(await sign(), { action: OTHER_SCOPE });
  show(`the same agent asking for ${OTHER_SCOPE}`, outOfScope);
  const replay = await verify(first, { action: SCOPE });
  show('the first proof sent again', replay);

  await call('POST', `/v1/vcs/${encodeURIComponent(root.hop.id)}/revoke`, {});
  const afterRevoke = await verify(await sign(), { action: SCOPE });
  show('a new call after the root hop was revoked', afterRevoke);

  const expected = acceptable(accepted) && !acceptable(outOfScope) && !acceptable(replay) && !acceptable(afterRevoke);
  console.log(expected ? '\nAll four verdicts are as expected.' : '\nUNEXPECTED verdicts: see above.');
  if (!expected) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('[request-proof] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
