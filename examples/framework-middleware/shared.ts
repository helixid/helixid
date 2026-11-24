// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//    http://www.apache.org/licenses/LICENSE-2.0

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kyaos } from '@helixid/sdk-js';
import { createLocalVerifier, type LocalVerifier } from '@helixid/mcp-middleware';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const exampleRoot = __dirname;
/**
 * What setup records for the agent: its DID and key id, where `helix init`
 * wrote its private key (it never leaves this machine), the service it acts
 * at, and its delegation chain there (the root hop the operator issued).
 */
export const agentIdentityPath = join(exampleRoot, 'agent', 'agent.json');
export const helixApiUrl = (process.env.HELIX_API_URL ?? process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
/** The operator's admin key: setup registers the service, creates the agent and issues its root hop. */
export const adminApiKey = process.env.HELIX_ADMIN_API_KEY ?? '';
/** What the agent is attested for, and what the service's tools need. */
export const agentScopes = ['read:orders', 'read:catalog'];
export const serviceScopes = ['read:orders', 'read:catalog', 'write:inventory'];

export interface AgentIdentity {
  agentDid: string;
  /** The verification-method fragment `helix init` registered. */
  kid: string;
  signingKeyFile: string;
  serviceDid: string;
  chain: unknown[];
}

export function logStep(scope: string, message: string): void {
  console.log(`[${scope}] ${message}`);
}

export async function ensureAgentDirectory(): Promise<void> {
  await mkdir(dirname(agentIdentityPath), { recursive: true });
}

/** The agent setup recorded, or null before setup has run. */
export async function readAgentIdentity(): Promise<AgentIdentity | null> {
  try {
    return JSON.parse(await readFile(agentIdentityPath, 'utf8')) as AgentIdentity;
  } catch {
    return null;
  }
}

export async function requireAgentIdentity(): Promise<AgentIdentity> {
  const identity = await readAgentIdentity();
  if (!identity) throw new Error(`No agent at ${agentIdentityPath}. Run pnpm example:middleware:setup first.`);
  return identity;
}

/** The agent's own signer: EnvSigner reading the signing-key file `helix init` wrote. */
export async function agentSigner(identity: AgentIdentity): Promise<kyaos.Signer> {
  const env: Record<string, string> = {};
  for (const line of (await readFile(identity.signingKeyFile, 'utf8')).split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) env[match[1]!] = match[2]!;
  }
  return new kyaos.EnvSigner({ did: identity.agentDid, kid: identity.kid, env });
}

/**
 * The service's in-process verifier (story F-2): DID documents, cards and
 * status lists read from their publishers, nothing asked of a Helix database.
 * Against a local helixid it reads http on loopback, and binds the Helix
 * issuer to its identity status list (the list every hosted card names,
 * SPEC-ENTITY-CARD §10.3).
 */
export async function serviceVerifier(serviceDid: string): Promise<LocalVerifier> {
  const health = (await (await fetch(`${helixApiUrl}/health`)).json()) as { issuerDid: string };
  return createLocalVerifier({
    serviceDid,
    allowLoopbackHttp: true,
    statusListIssuers: { [health.issuerDid]: [`${helixApiUrl}/v1/status-list/helix-status-list-1`] },
  });
}
