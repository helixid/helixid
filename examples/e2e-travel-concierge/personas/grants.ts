// Local index of the consent grants this demo asked a service to issue, so the
// UI can show "Ada → Concierge at Helix Stay [read:catalog]" and offer a revoke
// button. The platform holds the grants themselves and is what signVP() picks
// them from; this file only remembers which grant id belongs to which
// (persona, traveler, service). Status is always re-read from the platform.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { env, type ServiceId, type UserId } from '../config.js';

export interface GrantRecord {
  id: string;
  personaId: string;
  userId: UserId;
  serviceId: ServiceId;
  scopes: string[];
  durability: 'standing' | 'session';
  validFrom: string;
  validUntil: string;
  revokedAt?: string;
}

async function readIndex(): Promise<GrantRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(env.grantIndexPath, 'utf8')) as { grants?: GrantRecord[] };
    return Array.isArray(parsed.grants) ? parsed.grants : [];
  } catch {
    return [];
  }
}

async function writeIndex(grants: GrantRecord[]): Promise<void> {
  await mkdir(dirname(env.grantIndexPath), { recursive: true });
  await writeFile(env.grantIndexPath, `${JSON.stringify({ grants }, null, 2)}\n`, 'utf8');
}

export async function listGrants(personaId?: string): Promise<GrantRecord[]> {
  const all = await readIndex();
  return personaId ? all.filter((grant) => grant.personaId === personaId) : all;
}

export async function addGrant(grant: GrantRecord): Promise<void> {
  const all = await readIndex();
  all.push(grant);
  await writeIndex(all);
}

export async function markGrantRevoked(id: string, revokedAt: string): Promise<GrantRecord | undefined> {
  const all = await readIndex();
  const grant = all.find((entry) => entry.id === id);
  if (grant) {
    grant.revokedAt = revokedAt;
    await writeIndex(all);
  }
  return grant;
}
