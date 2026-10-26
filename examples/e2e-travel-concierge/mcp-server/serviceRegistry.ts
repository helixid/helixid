// The MCP server plays two Service Providers, Helix Air and Helix Stay. Each
// is enrolled once as a service on the self-hosted API (POST /v1/services,
// admin-gated): the platform mints its DID and holds its key, so this process
// never holds one. The self-hosted API has no "list my services" route, so the
// DIDs are remembered in the state volume and reused across restarts.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SERVICES, type ServiceDefinition, type ServiceId, env } from '../config.js';
import { adminCall, describeApiError } from '../personas/platform.js';

export interface RegisteredService extends ServiceDefinition {
  did: string;
}

async function readIndex(): Promise<Partial<Record<ServiceId, string>>> {
  try {
    return JSON.parse(await readFile(env.serviceIndexPath, 'utf8')) as Partial<Record<ServiceId, string>>;
  } catch {
    return {};
  }
}

async function writeIndex(index: Partial<Record<ServiceId, string>>): Promise<void> {
  await mkdir(dirname(env.serviceIndexPath), { recursive: true });
  await writeFile(env.serviceIndexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

let registered: Record<ServiceId, RegisteredService> | null = null;

/** Enrolls any demo service not enrolled yet; returns all of them with their DIDs. */
export async function ensureServices(): Promise<Record<ServiceId, RegisteredService>> {
  if (registered) return registered;
  const index = await readIndex();
  const result = {} as Record<ServiceId, RegisteredService>;
  for (const definition of Object.values(SERVICES)) {
    let did = index[definition.id];
    if (!did) {
      const enrolled = await adminCall<{ did?: string }>('/v1/services', {
        // Service names are unique on a self-hosted server; the suffix keeps a
        // re-enrollment (state volume lost, database kept) from colliding.
        name: `${definition.name} ${Date.now().toString(36)}`,
        domain: definition.domain,
        requiredScopes: [...new Set(definition.tools.map((tool) => tool.requiredScope))],
        framework: 'express',
      });
      if (!enrolled.ok || !enrolled.body.did) {
        throw new Error(`Enrolling ${definition.name} failed: ${describeApiError(enrolled.body.error, enrolled.status)}`);
      }
      did = enrolled.body.did;
      index[definition.id] = did;
      await writeIndex(index);
    }
    result[definition.id] = { ...definition, did };
  }
  registered = result;
  return result;
}

/**
 * Asks the platform to sign a consent grant with this service's key: the
 * traveler `userDid` lets `agentDid` use `scopes` at this service. This is
 * the SP's half of a consent screen -- the agent never signs its own consent.
 */
export async function issueConsentGrant(
  service: RegisteredService,
  input: { agentDid: string; userDid: string; scopes: string[]; durability: 'standing' | 'session' },
): Promise<{ id: string; validFrom: string; validUntil: string; scopes: string[] }> {
  const res = await adminCall<{
    grantVC?: { id: string; validFrom: string; validUntil: string; credentialSubject: { scopes: string[] } };
  }>('/v1/service-delegation-grants', { serviceDid: service.did, ...input });
  if (!res.ok || !res.body.grantVC) throw new Error(describeApiError(res.body.error, res.status));
  const { grantVC } = res.body;
  return { id: grantVC.id, validFrom: grantVC.validFrom, validUntil: grantVC.validUntil, scopes: grantVC.credentialSubject.scopes };
}
