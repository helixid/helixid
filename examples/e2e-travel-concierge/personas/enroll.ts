// Shared enrollment used by both the seeder (initial Concierge) and the agent's
// runtime onboarding route (later agents). The seeder may mint its own one-use
// token for the default persona; runtime onboarding consumes the one-use token
// the user generated in Console. Either way, this onboards via POST /v1/onboard:
// the server generates and holds the agent's key, so nothing local is created
// and no passphrase is involved. Nothing here is stubbed.
import { HelixClient } from '@helixid/sdk-js';
import { env } from '../config.js';
import type { Persona } from './types.js';

export interface EnrollInput {
  id: string;
  displayName: string;
  scopes: string[];
  maxDelegationDepth?: number;
  /** If omitted, a one-use token is minted from `scopes`. */
  bootstrapToken?: string;
}

export interface EnrollResult {
  persona: Persona;
  vcId: string;
  did: string;
}

async function mintToken(displayName: string, scopes: string[], maxDelegationDepth = 0): Promise<string> {
  const res = await fetch(`${env.helixApiUrl}/v1/enrollment-tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agentName: displayName,
      requestedScopes: scopes,
      requestedDomains: [],
      maxDelegationDepth,
    }),
  });
  const body = (await res.json()) as { token?: string; error?: unknown };
  if (!res.ok || !body.token) {
    throw new Error(`Failed to mint enrollment token: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return body.token;
}

export async function enrollPersona(input: EnrollInput): Promise<EnrollResult> {
  const token = input.bootstrapToken ?? (await mintToken(input.displayName, input.scopes, input.maxDelegationDepth));

  const client = new HelixClient(env.helixApiUrl, { adminApiKey: env.adminApiKey });
  const { agentDid, vcId } = await client.onboardAgent(token, []);

  // Trust the credential's actual scopes (a supplied token may differ from the
  // requested scopes). The platform holds the credential, so this reads it back
  // rather than inspecting a locally-held copy.
  const issued = (await client.getVC(vcId)).vc as
    | { credentialSubject?: { privilegeScopes?: string[] } }
    | undefined;
  const scopes = issued?.credentialSubject?.privilegeScopes ?? input.scopes;
  const persona: Persona = { id: input.id, displayName: input.displayName, scopes, agentDid };
  return { persona, vcId, did: agentDid };
}
