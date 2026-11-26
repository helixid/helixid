// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//    http://www.apache.org/licenses/LICENSE-2.0
//
// What the KYA-OS example scripts share: calls to a local helixid, a service,
// a self-custody agent made with `helix init`, its root hop, and a request
// proof signed with the agent's own key. Not an example of its own.

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { helixInit, kyaos } from '@helixid/sdk-js';

export const API = (process.env.HELIX_API_URL ?? process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
export const ADMIN_API_KEY = process.env.HELIX_ADMIN_API_KEY;

/** A delegation hop (§6.10) as helixid returns it and a chain carries it. */
export interface Hop {
  id: string;
  issuer: string;
  '@context'?: unknown;
  credentialSubject: { invoker: string; invocationTarget: string; allowedAction: string[]; parentCapability?: string };
  [key: string]: unknown;
}

/** What `POST /v1/verify` (and the in-process verifier) answers. */
export interface Verdict {
  ok: boolean;
  level?: string;
  agentDid?: string;
  effectiveScopes?: string[];
  reasons?: string[];
}

export interface Agent {
  did: string;
  /** The verification-method fragment `helix init` registered. */
  kid: string;
  signer: kyaos.Signer;
  /** Where `helix init` wrote the private key; it never leaves this machine. */
  signingKeyFile: string;
}

/** A tool call and the request proof over it, as a service receives them. */
export interface SignedCall {
  request: { method: string; params: Record<string, unknown> };
  proof: unknown;
}

export function requireAdminKey(): void {
  if (!ADMIN_API_KEY) throw new Error('Set HELIX_ADMIN_API_KEY to the API admin key (the same value the API runs with).');
}

export async function call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, admin = true): Promise<T> {
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
export function cardPath(did: string): string {
  return `/${did.split(':').slice(3).map(decodeURIComponent).join('/')}/card.json`;
}

/** `NAME=value` lines of the signing-key file `helix init` wrote, comments skipped. */
export function envFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) env[match[1]!] = match[2]!;
  }
  return env;
}

/** A short suffix that keeps every run's names apart. */
export const runSuffix = (): string => Date.now().toString(36);

/** Registers a service offering `scopes` (`POST /v1/services`, admin key). */
export async function createService(name: string, scopes: string[]): Promise<{ did: string }> {
  return call<{ did: string }>('POST', '/v1/services', { name, domain: `${name}.example.com`, requiredScopes: scopes });
}

/**
 * A self-custody agent (story F-3): `POST /v1/agents` with `keyCustody:
 * 'self'`, then `helix init`, which generates the key here and sends helixid
 * only its public half. helixid publishes the DID document and card.
 */
export async function createSelfCustodyAgent(name: string, scopes: string[]): Promise<Agent> {
  const created = await call<{ enrollmentToken: string }>('POST', '/v1/agents', { name, scopes, keyCustody: 'self', didHosting: 'helix' });
  const outDir = await mkdtemp(join(tmpdir(), 'helix-agent-'));
  const init = await helixInit({ apiUrl: API, enrollmentToken: created.enrollmentToken, outDir });
  const kid = init.kid.slice(init.kid.indexOf('#') + 1);
  const signer = new kyaos.EnvSigner({ did: init.did, kid, env: envFile(await readFile(init.files.signingKey, 'utf8')) });
  return { did: init.did, kid, signer, signingKeyFile: init.files.signingKey };
}

/** The agent's card as its DID document names it (public, no key). */
export async function cardOf(did: string): Promise<{ responsibleParty?: string; [key: string]: unknown }> {
  return call('GET', cardPath(did), undefined, false);
}

/** Roots the agent's authority over the service (`POST /v1/grants`): the first hop of its chain, issued by its responsible party. */
export async function rootHop(agentDid: string, serviceDid: string, allowedAction: string[]): Promise<Hop> {
  const card = await cardOf(agentDid);
  const root = await call<{ hop: Hop }>('POST', '/v1/grants', { issuer: card.responsibleParty, invoker: agentDid, invocationTarget: serviceDid, allowedAction });
  return root.hop;
}

/** The agent signs one `tools/call` with its own key (story C-C), carrying `chain`, for `audience`. */
export async function signCall(signer: kyaos.Signer, audience: string, chain: unknown[], tool = 'search_catalog', args: Record<string, unknown> = { q: 'shoes' }): Promise<SignedCall> {
  const request = { method: 'tools/call', params: { name: tool, arguments: args } };
  const signed = (await kyaos.withRequestProof(request, signer, { audience, chain })) as { params: { _meta: Record<string, unknown> } };
  return { request, proof: signed.params._meta['org.kya-os/request-proof'] };
}

/** The service's policy: the KYA-OS default minimum, L3 (a fresh status read). */
export const acceptable = (verdict: Verdict): boolean => verdict.ok && verdict.level === 'L3';

export function show(label: string, verdict: Verdict): void {
  const detail = verdict.ok
    ? `verified at ${verdict.level}${verdict.level === 'L3' ? '' : ' (not fresh: below the L3 this service requires)'}, scopes [${(verdict.effectiveScopes ?? []).join(', ')}]`
    : `${(verdict.reasons ?? []).join(', ')}`;
  console.log(`  ${label}: ${acceptable(verdict) ? 'accepted' : 'refused'} (${detail})`);
}

/** Ends the script: says whether every verdict was the one expected, and sets the exit code. */
export function finish(expected: boolean, count: string): void {
  console.log(expected ? `\nAll ${count} verdicts are as expected.` : '\nUNEXPECTED verdicts: see above.');
  if (!expected) process.exitCode = 1;
}

export function fail(script: string): (error: unknown) => never {
  return (error: unknown) => {
    console.error(`[${script}] failed:`, error instanceof Error ? error.message : error);
    process.exit(1);
  };
}
