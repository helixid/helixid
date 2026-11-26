// Boots one SP app from its enrolled identity. Both sp-airline/server.ts and
// sp-hotel/server.ts are three-line wrappers around this.

import 'dotenv/config';
import { allowLoopbackHttp, env, type SpDefinition } from '../helixid-config/index.js';
import { createSpApp } from './app.js';
import { createGate } from './kyaos-gate.js';
import { createAuditEmitter } from './audit.js';
import { loadSpIdentity } from './identity.js';

export async function serveSp(definition: SpDefinition): Promise<void> {
  const identity = await loadSpIdentity(env.walletsDir, definition.id);

  const gate = await createGate({
    serviceDid: identity.did,
    signingKey: identity.signingKey,
    helixApiUrl: env.helixApiUrl,
    displayName: definition.displayName,
    catalog: definition.scopeCatalog.map((entry) => entry.scope),
    windowSeconds: env.consentWindowSeconds,
    hopLifetimeSeconds: env.consentHopLifetimeSeconds,
    allowLoopbackHttp,
  });
  const { app } = createSpApp({
    definition,
    issuer: { did: identity.did },
    gate,
    // This SP's own verification and authorization decisions, in its own log.
    audit: createAuditEmitter({ serviceDid: identity.did, serviceName: definition.displayName }),
  });

  app.listen(definition.port, '0.0.0.0', () => {
    console.log(`[${definition.id}] ${definition.displayName} listening on :${definition.port}`);
    console.log(`[${definition.id}] did:web  ${identity.did} (service ${identity.serviceId}, its own key)`);
    console.log(`[${definition.id}] consent  Helix's consent page at ${env.helixApiUrl}/consent/<request>, per challenge`);
  });
}
