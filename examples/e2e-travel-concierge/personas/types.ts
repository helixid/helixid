// A "persona" is a selectable onboarded-agent context: its own DID, its own
// credential, its own scopes. Switching personas in the UI switches which
// agent presents the next protected tool call. There is no local key
// material anywhere in this app -- agent self-custody is retired, so the
// server generates and holds each agent's key, and every VP is signed via
// POST /v1/agents/:did/vp (see agent/tools/protectedCall.ts).

export interface Persona {
  id: string;
  displayName: string;
  /** Scopes the credential carries (informational — enforcement is server-side). */
  scopes: string[];
  /** The agent's DID, from POST /v1/onboard -- identifies it to signVP, never a key. */
  did: string;
  /** The credential id POST /v1/onboard issued alongside `did`. */
  vcId: string;
  /**
   * Set once a delegation lands this persona a delegated credential (see
   * /delegate-agent). The server presents it alongside `vcId` on every VP,
   * which is what gives a persona onboarded with zero scopes of its own
   * (e.g. the demo's Research Agent) any authority at all.
   */
  delegatedVcId?: string;
  /** Scopes the delegated credential carries, and when it lapses. */
  delegatedScopes?: string[];
  delegatedBy?: string;
  delegationExpiresAt?: string;
  /** The root credential's delegation budget (0 = may not delegate). */
  maxDelegationDepth?: number;
  /** Which guided scenario created this persona -- only used to group the UI's agent list. */
  group?: string;
  /** Informational lifecycle flags, set by this app's revoke/deactivate routes. */
  revokedAt?: string;
  deactivatedAt?: string;
}

/** The projection sent to the browser -- just enough to pick and label a persona. No DID-bound key material exists to leak. */
export interface PersonaPublic {
  id: string;
  displayName: string;
  scopes: string[];
  did: string;
  delegatedScopes?: string[];
  delegatedBy?: string;
  delegationExpiresAt?: string;
  maxDelegationDepth?: number;
  group?: string;
  revokedAt?: string;
  deactivatedAt?: string;
}

export function toPublic(p: Persona): PersonaPublic {
  return {
    id: p.id,
    displayName: p.displayName,
    scopes: p.scopes,
    did: p.did,
    ...(p.delegatedScopes ? { delegatedScopes: p.delegatedScopes } : {}),
    ...(p.delegatedBy ? { delegatedBy: p.delegatedBy } : {}),
    ...(p.delegationExpiresAt ? { delegationExpiresAt: p.delegationExpiresAt } : {}),
    ...(p.maxDelegationDepth !== undefined ? { maxDelegationDepth: p.maxDelegationDepth } : {}),
    ...(p.group ? { group: p.group } : {}),
    ...(p.revokedAt ? { revokedAt: p.revokedAt } : {}),
    ...(p.deactivatedAt ? { deactivatedAt: p.deactivatedAt } : {}),
  };
}
