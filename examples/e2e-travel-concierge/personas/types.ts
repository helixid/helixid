// A "persona" is a selectable onboarded-agent context: its own DID, its own
// credential, its own scopes. Switching personas in the UI switches which agent
// the API signs the next protected tool call for.
//
// Agent self-custody is retired, so a persona owns no wallet and no key — the
// server holds both, and a persona is identified by its DID.

export interface Persona {
  id: string;
  displayName: string;
  /** Scopes the credential carries (informational — enforcement is server-side). */
  scopes: string[];
  /** The agent's DID. Server custody: no wallet file, no local key material. */
  agentDid: string;
  /** Preferred VC for signing, used by the delegation demo after a child VC is added. */
  activeCredentialId?: string;
  /** Safe delegation metadata for the UI; no credential material. */
  delegatedFromPersonaId?: string;
  delegatedScopes?: string[];
}

/** The safe projection sent to the browser: no credential material, ever. */
export interface PersonaPublic {
  id: string;
  displayName: string;
  scopes: string[];
  delegatedFromPersonaId?: string;
  delegatedScopes?: string[];
}

export function toPublic(p: Persona): PersonaPublic {
  return {
    id: p.id,
    displayName: p.displayName,
    scopes: p.scopes,
    delegatedFromPersonaId: p.delegatedFromPersonaId,
    delegatedScopes: p.delegatedScopes,
  };
}
