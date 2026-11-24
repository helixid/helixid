// A "persona" is a selectable onboarded-agent context: its own DID, its own
// key (self custody, in its key directory on the shared volume), the scopes
// its card attests, and the delegation chain it carries at the service.
// Switching personas in the UI switches which agent signs the next tool call.

/** A KYA-OS DelegationCredential hop, as HelixID or a delegating agent signed it. */
export type Hop = Record<string, unknown> & {
  id: string;
  issuer: string;
  validUntil: string;
  credentialSubject: { invoker?: string; invocationTarget?: string; allowedAction?: string[] };
};

export interface Persona {
  id: string;
  displayName: string;
  /** What its Entity Card attests (its capability attestations). Authority never exceeds them. */
  scopes: string[];
  /** The agent's DID; its key is in its key directory, never sent anywhere. */
  agentDid: string;
  /** Its identity credential: revoking it revokes the agent (its card's revocation entry). */
  vcId: string;
  /**
   * The chain it carries at the service, root first: the root hop its
   * responsible party issued (its own authority), or that root plus the hop a
   * delegating agent signed. Absent: no authority at the service.
   */
  chain?: Hop[];
  /** Its own status list (a self-custody issuer of hops signs it), once it has delegated. */
  statusList?: string;
  /** Safe delegation metadata for the UI; no credential material. */
  delegatedFromPersonaId?: string;
  delegatedScopes?: string[];
  revokedAt?: string;
}

/** The safe projection sent to the browser: no key, no credential material, ever. */
export interface PersonaPublic {
  id: string;
  displayName: string;
  scopes: string[];
  /** What its chain allows at the service (empty: no authority). */
  authority: string[];
  delegatedFromPersonaId?: string;
  delegatedScopes?: string[];
}

export function toPublic(p: Persona): PersonaPublic {
  const leaf = p.chain?.[p.chain.length - 1];
  return {
    id: p.id,
    displayName: p.displayName,
    scopes: p.scopes,
    authority: leaf?.credentialSubject.allowedAction ?? [],
    delegatedFromPersonaId: p.delegatedFromPersonaId,
    delegatedScopes: p.delegatedScopes,
  };
}
