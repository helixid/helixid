// The SP's KYA-OS gate (stories F-2, C-C, L3-E, L3-H), one per SP.
//
// Every tools/call carries a request proof the agent signed and, once the
// user consented, its delegation chain: the root hop the user's own did:key
// signed on Helix's consent page. The SP verifies both in-process with
// @helixid/mcp-middleware's local verifier (no call to Helix: the cross-border
// rule). A call without the user's authority gets the signed
// needs_authorization challenge, whose authorizationUrl is Helix's consent
// page for a consent request this SP signed (createHelixConsent). Every answer
// carries this SP's response proof, so the agent can check that the consent
// URL it shows the user is the one this SP sent.
//
// The SP keeps its own key (self custody, its did:web hosted by Helix): it
// signs its consent requests and its response proofs. It holds no key able to
// sign as a user.

import { kyaos } from '@helixid/sdk-js';
import {
  MemoryResumeTokenStore,
  attachResponseProof,
  buildResponseProof,
  challengeToolResult,
  consentRetryAuthorizer,
  createHelixConsent,
  createLocalVerifier,
  createNeedsAuthorization,
  type LocalVerifier,
  type NeedsAuthorization,
  type NeedsAuthorizationChallenge,
} from '@helixid/mcp-middleware';

export interface GateOptions {
  serviceDid: string;
  /** This SP's Ed25519 private key (hex); its did:web document lists it as key-1. */
  signingKey: string;
  helixApiUrl: string;
  displayName: string;
  /** The scopes this SP offers: effective scopes are intersected with it. */
  catalog: readonly string[];
  /** How long a user's consent lasts, and each hop inside it (renewed by the agent without a click). */
  windowSeconds: number;
  hopLifetimeSeconds: number;
  /** Local runs: DID documents, cards and status lists on loopback http. */
  allowLoopbackHttp: boolean;
}

export type Verdict =
  | { ok: true; agentDid: string; userDid: string | undefined; scopes: string[]; level: string }
  | { ok: false; code: string; message: string };

export interface Gate {
  verifier: LocalVerifier;
  needsAuthorization: NeedsAuthorization;
  /** The call's agent and what it may do here: its own proof, and the chain the user signed. */
  verify(request: { method: string; params: Record<string, unknown> }): Promise<Verdict>;
  /** The signed challenge for a call lacking `scope`, for the user this SP names. */
  challenge(input: { agentDid: string; tool: string; scope: string; serviceUserId: string }): Promise<NeedsAuthorizationChallenge>;
  /** `result` with this SP's response proof. */
  sign(request: { method: string; params: Record<string, unknown> }, result: Record<string, unknown>, outcome: 'allowed' | 'needs_authorization' | 'denied', clientDid?: string): Promise<Record<string, unknown>>;
}

/** The Helix issuer keeps its own list: what a service binds so an agent card's revocation entry is read (SPEC-ENTITY-CARD §10.3). */
async function helixStatusListBinding(helixApiUrl: string): Promise<Record<string, string[]> | undefined> {
  const health = (await (await fetch(`${helixApiUrl}/health`)).json().catch(() => ({}))) as { issuerDid?: string };
  return health.issuerDid ? { [health.issuerDid]: [`${helixApiUrl}/v1/status-list/helix-status-list-1`] } : undefined;
}

export async function createGate(options: GateOptions): Promise<Gate> {
  const signer = new kyaos.EnvSigner({ did: options.serviceDid, envVar: 'SP_KEY', env: { SP_KEY: options.signingKey } });
  const statusListIssuers = await helixStatusListBinding(options.helixApiUrl);
  const verifier = createLocalVerifier({
    serviceDid: options.serviceDid,
    catalog: options.catalog,
    allowLoopbackHttp: options.allowLoopbackHttp,
    // Every scope here is the user's: an agent gets it only through the user's consent, never on its own authority.
    allowOwnAuthority: false,
    ...(statusListIssuers === undefined ? {} : { statusListIssuers }),
    log: () => undefined,
  });
  const consent = createHelixConsent({
    helixUrl: options.helixApiUrl,
    serviceDid: options.serviceDid,
    signer,
    windowSeconds: options.windowSeconds,
    hopLifetimeSeconds: options.hopLifetimeSeconds,
    display: { serviceName: options.displayName },
  });
  const needsAuthorization = createNeedsAuthorization({
    authorizationUrl: consent.authorizationUrl,
    authorizer: consentRetryAuthorizer(verifier),
    store: new MemoryResumeTokenStore(),
    serviceDid: options.serviceDid,
  });

  const verify: Gate['verify'] = async (request) => {
    const params = request.params;
    const result = await verifier.verifyCall({
      name: params['name'] as string,
      input: params['arguments'] as Record<string, unknown>,
      _meta: params['_meta'] as Record<string, unknown>,
      request,
      liveStatus: true,
    });
    if (result === undefined) return { ok: false, code: 'proof_missing', message: 'the call carries no request proof' };
    if (!result.ok || result.agentDid === undefined) return { ok: false, code: result.reasons[0] ?? 'refused', message: result.messages.join('; ') };
    const root = result.chainSummary.responsibleParty;
    return { ok: true, agentDid: result.agentDid, userDid: root?.startsWith('did:key:') ? root : undefined, scopes: result.effectiveScopes, level: result.level };
  };

  const challenge: Gate['challenge'] = async (input) => {
    const error = await needsAuthorization.challenge({ agentDid: input.agentDid, tool: input.tool, scopes: [input.scope], oauthSubject: input.serviceUserId });
    return error.challenge;
  };

  const sign: Gate['sign'] = async (request, result, outcome, clientDid) => {
    const proof = await buildResponseProof(
      {
        did: options.serviceDid,
        kid: `${options.serviceDid}#key-1`,
        ts: Math.floor(Date.now() / 1000),
        nonce: kyaos.generateNonce(),
        audience: options.serviceDid,
        sessionId: 'none',
        requestHash: kyaos.hashRequest(request),
        ...(outcome === 'denied' ? {} : { responseHash: kyaos.hashResponse(result, kyaos.RESPONSE_PROOF_ENVELOPE_PROFILE), prf: kyaos.RESPONSE_PROOF_ENVELOPE_PROFILE }),
        outcome,
        ...(clientDid === undefined ? {} : { clientDid }),
      } as kyaos.ProofMeta,
      signer,
    );
    return attachResponseProof(result, proof);
  };

  return { verifier, needsAuthorization, verify, challenge, sign };
}

export { challengeToolResult };
