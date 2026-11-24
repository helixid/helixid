// Shared enrollment, used by the seeder (initial Concierge), the runtime
// onboarding route (a Console-generated enrollment token) and the delegation
// demo. helixid is self custody: the admin creates the agent (POST /v1/agents,
// keyCustody 'self'), and `helixInit` generates the agent's key locally,
// proves it to HelixID with the enrollment token and writes the DID document,
// card and signing key to the persona's key directory. Only the public key is
// ever sent.
//
// With `ownAuthority` (default), its responsible party -- the party its card
// names -- then issues the root hop of its chain at the service (admin POST
// /v1/grants), allowing what the card attests. Without it, the agent has an
// identity and attestations but no authority until another agent delegates.
import { helixInit } from '@helixid/sdk-js';
import { env, keyDirFor } from '../config.js';
import { admin, helixFetch } from '../helixid.js';
import { loadService } from '../service/identity.js';
import type { Hop, Persona } from './types.js';

export interface EnrollInput {
  id: string;
  displayName: string;
  /** What to attest; ignored with a Console token (the token carries them). */
  scopes: string[];
  /** A Console-generated enrollment token; without one the admin creates the agent. */
  bootstrapToken?: string;
  ownAuthority?: boolean;
}

export interface EnrollResult {
  persona: Persona;
  vcId: string;
  did: string;
}

/** The party the agent's card names as responsible (or its identity credential, for an agent acting on user consent). */
async function responsiblePartyOf(card: { responsibleParty?: string }, vcId: string | undefined): Promise<string> {
  if (card.responsibleParty) return card.responsibleParty;
  if (vcId) {
    const vc = await admin<{ vc?: { credentialSubject?: { responsibleParty?: string } } }>('GET', `/v1/vcs/${encodeURIComponent(vcId)}`);
    const party = vc.vc?.credentialSubject?.responsibleParty;
    if (party) return party;
  }
  throw new Error('the agent has no responsible party to root its chain');
}

/** The root hop the agent's responsible party issues at the service. */
export async function issueRootHop(agentDid: string, responsibleParty: string, allowedAction: string[]): Promise<Hop> {
  const service = await loadService();
  const { hop } = await admin<{ hop: Hop }>('POST', '/v1/grants', { issuer: responsibleParty, invoker: agentDid, invocationTarget: service.did, allowedAction });
  return hop;
}

export async function enrollPersona(input: EnrollInput): Promise<EnrollResult> {
  const token =
    input.bootstrapToken ??
    (await admin<{ enrollmentToken?: string }>('POST', '/v1/agents', { name: input.displayName, scopes: input.scopes, keyCustody: 'self' })).enrollmentToken;
  if (!token) throw new Error('POST /v1/agents answered without an enrollment token');

  const init = await helixInit({ apiUrl: env.helixApiUrl, enrollmentToken: token, outDir: keyDirFor(input.id) });
  const card = (await (await helixFetch(init.cardUrl)).json()) as { responsibleParty?: string; capabilities?: { name: string }[] };
  const scopes = (card.capabilities ?? []).map((capability) => capability.name);
  const vcId = init.vcId ?? '';

  let chain: Hop[] | undefined;
  if ((input.ownAuthority ?? true) && scopes.length > 0) {
    chain = [await issueRootHop(init.did, await responsiblePartyOf(card, init.vcId), scopes)];
  }
  const persona: Persona = { id: input.id, displayName: input.displayName, scopes, agentDid: init.did, vcId, ...(chain ? { chain } : {}) };
  return { persona, vcId, did: init.did };
}
