// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//    http://www.apache.org/licenses/LICENSE-2.0
//
// One-time operator setup, against a running helixid:
//   1. register the service the agent will call (POST /v1/services);
//   2. create a self-custody agent (POST /v1/agents, story F-3) and run
//      `helix init` for it here: its key is generated on this machine and
//      only the public half reaches helixid;
//   3. root the agent's authority over the service (POST /v1/grants): one
//      delegation hop (§6.10), the agent's chain.
// It records the result in agent/agent.json for langchain.ts and mcp.ts.

import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { helixInit } from '@helixid/sdk-js';
import { adminApiKey, agentIdentityPath, agentScopes, ensureAgentDirectory, exampleRoot, helixApiUrl, logStep, serviceScopes, type AgentIdentity } from './shared.js';

async function admin<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${helixApiUrl}${path}`, {
    method,
    headers: { 'x-admin-api-key': adminApiKey, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await response.json().catch(() => ({}))) as T & { error?: { code?: string; message?: string } };
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${json.error?.code ?? ''} ${json.error?.message ?? ''}`.trim());
  return json;
}

async function main(): Promise<void> {
  if (!adminApiKey) throw new Error('Set HELIX_ADMIN_API_KEY to the API admin key.');
  await ensureAgentDirectory();
  const suffix = Date.now().toString(36);

  const service = await admin<{ did: string }>('POST', '/v1/services', { name: `framework-orders-${suffix}`, domain: `orders-${suffix}.example.com`, requiredScopes: serviceScopes });
  logStep('Setup', `Service ${service.did} (tools need ${serviceScopes.join(', ')}).`);

  const created = await admin<{ did: string; enrollmentToken: string }>('POST', '/v1/agents', { name: `framework-agent-${suffix}`, scopes: agentScopes, keyCustody: 'self', didHosting: 'helix' });
  const init = await helixInit({ apiUrl: helixApiUrl, enrollmentToken: created.enrollmentToken, outDir: join(exampleRoot, 'agent') });
  logStep('Setup', `Agent ${init.did} enrolled by helix init; its key is in ${init.files.signingKey} and was never sent.`);

  const card = (await (await fetch(`${helixApiUrl}/${init.did.split(':').slice(3).map(decodeURIComponent).join('/')}/card.json`)).json()) as { responsibleParty?: string };
  const root = await admin<{ hop: { id: string } }>('POST', '/v1/grants', { issuer: card.responsibleParty, invoker: init.did, invocationTarget: service.did, allowedAction: agentScopes });
  logStep('Setup', `Root hop ${root.hop.id}: ${agentScopes.join(', ')} at the service.`);

  const identity: AgentIdentity = {
    agentDid: init.did,
    kid: init.kid.slice(init.kid.indexOf('#') + 1),
    signingKeyFile: init.files.signingKey,
    serviceDid: service.did,
    chain: [root.hop],
  };
  await writeFile(agentIdentityPath, `${JSON.stringify(identity, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  logStep('Setup', `Recorded in ${agentIdentityPath}.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
