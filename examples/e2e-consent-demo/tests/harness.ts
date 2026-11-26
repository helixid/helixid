// The two-SP harness: a real helix-api (in process, SQLite, did:web so it can
// host the SPs' and the agent's DID documents), both SP servers on real
// ports, and a self-custody agent, so every assertion runs the shipped code
// paths end to end: Helix's consent page, the user's did:key, request proofs,
// local verification and response proofs. No LLM.

import type { Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { helixInit, kyaos } from '@helixid/sdk-js';
import { AGENT_PRIVILEGE_SCOPES, AIRLINE, DEMO_SERVICE_USER, HOTEL, type SpDefinition } from '../helixid-config/index.js';
import { createSpApp, type SpApp } from '../sp-shared/app.js';
import { createAuditEmitter } from '../sp-shared/audit.js';
import { enrollSpService } from '../sp-shared/identity.js';
import { createGate } from '../sp-shared/kyaos-gate.js';
import { ConsentStore } from '../agent/consentStore.js';
import type { CallSpToolOptions } from '../agent/consentAwareCall.js';
import { startLiveApi } from '../../../tests/utils/liveApi.js';

export interface RunningSp {
  spApp: SpApp;
  server: Server;
  mcpUrl: string;
  serviceDid: string;
  definition: SpDefinition;
  /** The SP's activity log lines (sp-shared/audit.ts), parsed. */
  audit: Array<Record<string, unknown>>;
}

export interface Harness {
  workDir: string;
  helixApiUrl: string;
  airline: RunningSp;
  hotel: RunningSp;
  agentDid: string;
  signer: kyaos.Signer;
  consents: ConsentStore;
  /** The options callSpTool/completeConsent take for `sp`, minus the tool. */
  callOptions(sp: RunningSp, toolName: string, args?: Record<string, unknown>): CallSpToolOptions;
  /** Plays the user on Helix's consent page: opens it (page cookie, form token) and presses Allow or Decline. */
  decide(authorizationUrl: string, decision: 'approve' | 'deny'): Promise<void>;
  stop(): Promise<void>;
}

const resolveDid = kyaos.verifier.createDidResolver({ rewriteUrl: (url) => url.replace(/^https:\/\/(localhost|127\.0\.0\.1)([:/])/, 'http://$1$2') });

async function startSp(workDir: string, definition: SpDefinition, port: number, helixApiUrl: string, adminApiKey: string): Promise<RunningSp> {
  const { identity } = await enrollSpService({ dir: workDir, definition, host: '127.0.0.1', port, helixApiUrl, adminApiKey });
  const gate = await createGate({
    serviceDid: identity.did,
    signingKey: identity.signingKey,
    helixApiUrl,
    displayName: definition.displayName,
    catalog: definition.scopeCatalog.map((entry) => entry.scope),
    windowSeconds: 30 * 24 * 3600,
    hopLifetimeSeconds: 3600,
    allowLoopbackHttp: true,
  });
  const audit: Array<Record<string, unknown>> = [];
  const spApp = createSpApp({
    definition: { ...definition, port },
    issuer: { did: identity.did },
    gate,
    audit: createAuditEmitter({ serviceDid: identity.did, serviceName: definition.displayName, write: (line) => audit.push(JSON.parse(line) as Record<string, unknown>) }),
  });
  const server = await new Promise<Server>((resolve) => {
    const listening = spApp.app.listen(port, '127.0.0.1', () => resolve(listening));
  });
  return { spApp, server, mcpUrl: `http://127.0.0.1:${port}/api/mcp`, serviceDid: identity.did, definition, audit };
}

async function onboardAgent(workDir: string, helixApiUrl: string, adminApiKey: string): Promise<{ did: string; signer: kyaos.Signer }> {
  const res = await fetch(`${helixApiUrl}/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-api-key': adminApiKey },
    body: JSON.stringify({ name: 'Travel Planner Agent (test)', scopes: AGENT_PRIVILEGE_SCOPES, keyCustody: 'self' }),
  });
  const created = (await res.json()) as { enrollmentToken?: string };
  if (!created.enrollmentToken) throw new Error(`agent creation failed: HTTP ${res.status}`);
  const outDir = join(workDir, 'agent');
  const init = await helixInit({ apiUrl: helixApiUrl, enrollmentToken: created.enrollmentToken, outDir });
  const keyEnv = Object.fromEntries(
    (await readFile(init.files.signingKey, 'utf8')).split('\n').filter((line) => line.includes('=')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  return { did: init.did, signer: new kyaos.EnvSigner({ did: init.did, kid: init.kid.split('#').pop()!, envVar: init.envVar, env: keyEnv }) };
}

async function decide(authorizationUrl: string, decision: 'approve' | 'deny'): Promise<void> {
  const page = await fetch(authorizationUrl);
  const html = await page.text();
  if (!page.ok) throw new Error(`consent page: HTTP ${page.status}`);
  const cookie = page.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');
  const field = (name: string): string => (html.match(new RegExp(`name="${name}" value="([^"]*)"`)) ?? [])[1] ?? '';
  const form = new URLSearchParams({ pageToken: field('pageToken'), ...(decision === 'approve' ? { grantDigest: field('grantDigest') } : {}) });
  const answer = await fetch(`${authorizationUrl}/${decision}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: form.toString() });
  if (!answer.ok) throw new Error(`consent page refused the ${decision}: HTTP ${answer.status}`);
}

export async function startHarness(airlinePort: number, hotelPort: number): Promise<Harness> {
  const workDir = await mkdtemp(join(tmpdir(), 'helix-consent-demo-'));
  const api = await startLiveApi();
  const airline = await startSp(workDir, AIRLINE, airlinePort, api.baseUrl, api.adminApiKey);
  const hotel = await startSp(workDir, HOTEL, hotelPort, api.baseUrl, api.adminApiKey);
  const agent = await onboardAgent(workDir, api.baseUrl, api.adminApiKey);
  const consents = new ConsentStore(join(workDir, 'consents.json'));
  return {
    workDir,
    helixApiUrl: api.baseUrl,
    airline,
    hotel,
    agentDid: agent.did,
    signer: agent.signer,
    consents,
    callOptions: (sp, toolName, args) => ({
      signer: agent.signer,
      agentDid: agent.did,
      consents,
      serviceUserId: DEMO_SERVICE_USER,
      spMcpUrl: sp.mcpUrl,
      serviceDid: sp.serviceDid,
      toolName,
      resolveDid,
      ...(args ? { args } : {}),
    }),
    decide,
    stop: async () => {
      await Promise.all([airline, hotel].map((sp) => new Promise<void>((resolve) => sp.server.close(() => resolve()))));
      await api.stop();
      await rm(workDir, { recursive: true, force: true });
    },
  };
}
