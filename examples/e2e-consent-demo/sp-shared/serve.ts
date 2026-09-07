// Boots one SP app from its provisioned identity. Both sp-airline/server.ts and
// sp-hotel/server.ts are three-line wrappers around this.

import 'dotenv/config';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { buildStatusListCredential, createStatusList } from '@helixid/sdk-js';
import { env, type SpDefinition } from '../helixid-config/index.js';
import { createSpApp } from './app.js';
import { createAuditEmitter } from './audit.js';
import { loadSpIdentity, statePath, STATUS_LIST_LENGTH } from './identity.js';
import { SpStore } from './store.js';

const requireFromHere = createRequire(import.meta.url);

export async function serveSp(definition: SpDefinition): Promise<void> {
  const identity = await loadSpIdentity(env.walletsDir, definition.id);
  const store = await SpStore.open(
    statePath(env.walletsDir, definition.id),
    buildStatusListCredential('1', createStatusList(STATUS_LIST_LENGTH), identity.did, identity.baseUrl),
  );

  const { app } = createSpApp({
    definition,
    issuer: {
      did: identity.did,
      privateKeyHex: identity.privateKeyHex,
      publicKeyHex: identity.publicKeyHex,
    },
    baseUrl: identity.baseUrl,
    helixApiUrl: env.helixApiUrl,
    // Scope resolution happens inside this same container. The public did:web
    // base URL can be localhost, but the server should call its own loopback.
    mcpServerUrl: `http://127.0.0.1:${definition.port}/api/mcp`,
    store,
    // @helixid/widget is an ordinary dependency now, so let Node resolve it
    // rather than assuming a sibling checkout. Its "." export is dist/index.js,
    // so that file's directory is the dist the consent page loads /widget/*
    // from. Resolving also survives pnpm putting the package in a
    // content-addressed store path that no relative path could name.
    widgetDistPath: dirname(requireFromHere.resolve('@helixid/widget')),
    // Reports this SP's own verification and authorization decisions to the
    // shared audit log. Unconfigured (no URL/key) degrades to a no-op emitter.
    audit: createAuditEmitter({
      helixApiUrl: env.helixApiUrl,
      adminApiKey: env.adminApiKey,
      serviceDid: identity.did,
      serviceName: definition.displayName,
      onError: (message) => console.warn(`[${definition.id}] ${message}`),
    }),
  });

  app.listen(definition.port, '0.0.0.0', () => {
    console.log(`[${definition.id}] ${definition.displayName} listening on :${definition.port}`);
    console.log(`[${definition.id}] did:web  ${identity.did}`);
    console.log(`[${definition.id}] status   ${identity.statusListUrl}`);
    console.log(`[${definition.id}] consent  ${identity.baseUrl}/consent`);
  });
}
