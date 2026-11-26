// The MCP service's identity: a service enrolled on HelixID (admin POST
// /v1/services) that keeps its own key (self custody) while HelixID hosts its
// did:web. It signs every answer with that key (KYA-OS response proofs).
// The seeder enrolls it once and writes the identity to the shared volume;
// the MCP server signs with it and the agent reads its DID from it.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { generateKeyPair, kyaos } from '@helixid/sdk-js';
import { SCOPES, SERVICE_NAME, env } from '../config.js';
import { admin } from '../helixid.js';

export interface ServiceIdentity {
  did: string;
  /** The service's Ed25519 private key (hex): key-1 of its did:web document. */
  signingKey: string;
}

export async function loadService(): Promise<ServiceIdentity> {
  const raw = await readFile(env.serviceIdentityPath, 'utf8').catch(() => null);
  if (!raw) throw new Error(`No service identity at ${env.serviceIdentityPath}: run the seeder (pnpm run setup) first.`);
  return JSON.parse(raw) as ServiceIdentity;
}

/** The service's identity, enrolled on first use. */
export async function ensureService(): Promise<ServiceIdentity> {
  const existing = await loadService().catch(() => null);
  if (existing) return existing;
  const keys = generateKeyPair();
  const created = await admin<{ did?: string }>('POST', '/v1/services', {
    // Service names are unique on a deployment: a fresh key takes a fresh name.
    name: `${SERVICE_NAME} ${keys.publicKey.slice(0, 6)}`,
    domain: 'travel-booking-mcp.local',
    requiredScopes: [SCOPES.FLIGHTS_READ, SCOPES.FLIGHTS_BOOK],
    keyCustody: 'self',
    didHosting: 'helix',
    publicKeyJwk: kyaos.publicKeyHexToJwk(keys.publicKey),
  });
  if (!created.did) throw new Error('POST /v1/services answered without a DID');
  const identity: ServiceIdentity = { did: created.did, signingKey: keys.privateKey };
  await mkdir(dirname(env.serviceIdentityPath), { recursive: true });
  await writeFile(env.serviceIdentityPath, JSON.stringify(identity, null, 2), { encoding: 'utf8', mode: 0o600 });
  return identity;
}
