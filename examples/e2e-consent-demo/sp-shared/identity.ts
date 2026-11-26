// SP identity: a service enrolled at HelixID (admin POST /v1/services) that
// keeps its own key (self custody) while HelixID hosts its did:web
// (did:web:<api-host>:services:<hex>). The SP signs its consent requests and
// its response proofs with that key (KYA-OS stories L2-A, L3-H); HelixID never
// sees it. The seeder writes the identity and the key to a small local JSON
// file once (a demo: a real service keeps its key in a secret store).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { generateKeyPair, kyaos } from '@helixid/sdk-js';
import { join } from 'node:path';
import type { SpDefinition } from '../helixid-config/index.js';

export interface SpIdentityFile {
  serviceId: string;
  did: string;
  baseUrl: string;
  /** The SP's Ed25519 private key (hex): key-1 of its did:web document. */
  signingKey: string;
}

function identityPath(dir: string, spId: string): string {
  return join(dir, `sp-${spId}.identity.json`);
}

export async function enrollSpService(params: {
  dir: string;
  definition: SpDefinition;
  host: string;
  port: number;
  helixApiUrl: string;
  /** The operator's admin key. */
  adminApiKey: string;
}): Promise<{ identity: SpIdentityFile; created: boolean }> {
  const { definition } = params;
  const path = identityPath(params.dir, definition.id);

  const existing = await readFile(path, 'utf8').catch(() => null);
  if (existing) {
    return { identity: JSON.parse(existing) as SpIdentityFile, created: false };
  }

  const baseUrl = `http://${params.host}:${params.port}`;
  const keys = generateKeyPair();
  const response = await fetch(new URL('/v1/services', params.helixApiUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-api-key': params.adminApiKey },
    body: JSON.stringify({
      // Service names are unique across the deployment; the consent page shows the display name each request sends.
      name: `${definition.displayName} (${params.host}:${params.port})`,
      domain: `${params.host}:${params.port}`,
      requiredScopes: definition.scopeCatalog.map((entry) => entry.scope),
      description: `${definition.displayName} (e2e-consent-demo)`,
      framework: 'express',
      keyCustody: 'self',
      didHosting: 'helix',
      publicKeyJwk: kyaos.publicKeyHexToJwk(keys.publicKey),
    }),
  });
  const body = (await response.json()) as { id?: string; did?: string; service?: { id?: string }; error?: { message?: string } };
  const serviceId = body.id ?? body.service?.id;
  if (!response.ok || !serviceId || !body.did) {
    throw new Error(body.error?.message ?? `service enrollment failed: HTTP ${response.status}`);
  }

  const identity: SpIdentityFile = { serviceId, did: body.did, baseUrl, signingKey: keys.privateKey };
  await mkdir(params.dir, { recursive: true });
  await writeFile(path, JSON.stringify(identity, null, 2), { encoding: 'utf8', mode: 0o600 });
  return { identity, created: true };
}

export async function loadSpIdentity(dir: string, spId: string): Promise<SpIdentityFile> {
  const path = identityPath(dir, spId);
  try {
    return JSON.parse(await readFile(path, 'utf8')) as SpIdentityFile;
  } catch {
    throw new Error(`SP "${spId}" is not enrolled (${path} not found). Run: pnpm run setup`);
  }
}
