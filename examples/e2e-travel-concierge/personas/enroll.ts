// Shared enrollment used by both the seeder (initial Concierge) and the agent's
// runtime onboarding route (every scenario's agents). Mints a one-use
// enrollment token (or consumes one generated in Console) and onboards via
// POST /v1/onboard: the server generates and holds the agent's key, so
// nothing local is created and no passphrase is involved. Nothing here is
// stubbed.
import type { Persona } from './types.js';
import { adminCall, describeApiError } from './platform.js';

export interface EnrollInput {
  id: string;
  displayName: string;
  scopes: string[];
  maxDelegationDepth?: number;
  group?: string;
  /** If omitted, a one-use token is minted from `scopes`. */
  bootstrapToken?: string;
}

export interface EnrollResult {
  persona: Persona;
  vcId: string;
  did: string;
}

async function mintToken(displayName: string, scopes: string[], maxDelegationDepth = 0): Promise<string> {
  const res = await adminCall<{ token?: string }>('/v1/enrollment-tokens', {
    agentName: displayName,
    requestedScopes: scopes,
    requestedDomains: [],
    maxDelegationDepth,
  });
  if (!res.ok || !res.body.token) {
    throw new Error(`Failed to mint enrollment token: ${describeApiError(res.body.error, res.status)}`);
  }
  return res.body.token;
}

export async function enrollPersona(input: EnrollInput): Promise<EnrollResult> {
  const token = input.bootstrapToken ?? (await mintToken(input.displayName, input.scopes, input.maxDelegationDepth));
  const onboarded = await adminCall<{ agentDid?: string; vcId?: string }>('/v1/onboard', { enrollmentToken: token, domains: [] });
  if (!onboarded.ok || !onboarded.body.agentDid || !onboarded.body.vcId) {
    throw new Error(`Onboarding failed: ${describeApiError(onboarded.body.error, onboarded.status)}`);
  }
  const { agentDid, vcId } = onboarded.body;

  // Trust the credential's actual scopes (a supplied token may differ from the
  // requested scopes). The platform holds the credential, so this reads it back.
  const issued = await adminCall<{ vc?: { credentialSubject?: { privilegeScopes?: string[] } } }>(
    `/v1/vcs/${encodeURIComponent(vcId)}`,
    undefined,
    'GET',
  );
  const scopes = issued.body.vc?.credentialSubject?.privilegeScopes ?? input.scopes;
  const persona: Persona = {
    id: input.id,
    displayName: input.displayName,
    scopes,
    did: agentDid,
    vcId,
    ...(input.maxDelegationDepth !== undefined ? { maxDelegationDepth: input.maxDelegationDepth } : {}),
    ...(input.group ? { group: input.group } : {}),
  };
  return { persona, vcId, did: agentDid };
}
