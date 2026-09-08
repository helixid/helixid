import { HelixClient } from '@helixid/sdk-js';
import type { SignedVC, SignedVP } from '@helixid/sdk-js';

// Utility helpers for verifier examples
//
// Purpose
// - This module provides a small convenience helper `createFreshSignedVP()` used by
//   the examples. It requests an enrollment token from the API, onboards an agent
//   with `HelixClient.onboardAgent()`, and asks the API to sign a fresh VP on that
//   agent's behalf with `HelixClient.signVP()`.
//
// Why there is no wallet here any more
// - Agent self-custody has been retired. `onboardAgent()` returns only
//   `{ agentDid, vcId }` -- the server generates and holds the agent's private key
//   itself, so there is no local keypair, no wallet file and no passphrase to
//   manage. That also means the VP cannot be signed locally with `VPBuilder`: the
//   caller never has the key, so signing is an API call (`signVP()`).
// - This replaces both the old `enroll()` path and the two-step
//   challenge/response onboarding that briefly superseded it; all three of
//   `enroll()`, `requestOnboardingChallenge()` and `completeOnboarding()` were
//   removed from the SDK in the same sweep.
//
// Notes and caveats
// - Designed for examples and local testing only. In production, enrollment token
//   creation is an operator action and typically requires operator authentication
//   (admin API key). This helper posts to `/v1/enrollment-tokens` and therefore
//   assumes a permissive dev environment or test harness.
// - Environment: expects `helixApiUrl` to point at a running Helix API instance.
// - `signVP()` is admin-key gated in OSS/core (`POST /v1/agents/:did/vp`), so this
//   helper needs an admin key -- passed as `adminApiKey` or via
//   `HELIX_ADMIN_API_KEY`. That is a deliberate scoping reduction versus
//   self-custody, where only the agent's own key could sign for itself.

export type FreshVerifierVPOptions = {
  helixApiUrl: string;
  targetService: string;
  requiredScope?: string;
  userDid?: string;
  agentName?: string;
  /** Admin key for the admin-gated signing route; falls back to HELIX_ADMIN_API_KEY. */
  adminApiKey?: string;
};

type EnrollmentTokenResponse = {
  token: string;
  expiresAt: string;
};

export type FreshVerifierVP = {
  signedVP: SignedVP;
  vc: SignedVC;
  agentDid: string;
  userDid: string;
  targetService: string;
  enrollmentExpiresAt: string;
};

function uniqueScopes(requiredScope?: string): string[] {
  const defaults = ['read:catalog', 'read:orders', 'read:inventory'];
  if (!requiredScope) return defaults;
  return Array.from(new Set([...defaults, requiredScope]));
}

async function createEnrollmentToken(input: {
  helixApiUrl: string;
  agentName: string;
  requestedScopes: string[];
}): Promise<EnrollmentTokenResponse> {
  const response = await fetch(`${input.helixApiUrl}/v1/enrollment-tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agentName: input.agentName,
      requestedScopes: input.requestedScopes,
      requestedDomains: ['https://verifier.example.com'],
      maxDelegationDepth: 0,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Enrollment token creation failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }

  return (await response.json()) as EnrollmentTokenResponse;
}

export async function createFreshSignedVP(
  options: FreshVerifierVPOptions,
): Promise<FreshVerifierVP> {
  const requestedScopes = uniqueScopes(options.requiredScope);
  const userDid = options.userDid ?? 'did:key:z6MkuXVerifierUserDemo';
  const token = await createEnrollmentToken({
    helixApiUrl: options.helixApiUrl,
    agentName: options.agentName ?? 'Verifier Example Agent',
    requestedScopes,
  });

  const adminApiKey = options.adminApiKey ?? process.env.HELIX_ADMIN_API_KEY;
  if (!adminApiKey) {
    throw new Error(
      'createFreshSignedVP() needs an admin key to sign a VP for a server-custody ' +
        'agent: pass adminApiKey or set HELIX_ADMIN_API_KEY.',
    );
  }
  const client = new HelixClient(options.helixApiUrl, { adminApiKey });

  const { agentDid, vcId } = await client.onboardAgent(token.token, [
    'https://verifier.example.com',
  ]);

  // Read the VC back for callers that want to inspect it. The server already
  // holds it -- this is a read, not a local credential store.
  const vcResponse = await client.getVC(vcId);
  const vc = vcResponse.vc as SignedVC | undefined;
  if (!vc) {
    throw new Error(`Onboarding succeeded but VC ${vcId} could not be read back`);
  }

  // Signed by the API on the agent's behalf -- the caller never has the key.
  // Pinning vcId keeps this unambiguous once an agent holds more than one
  // active credential.
  const signedVP = await client.signVP(agentDid, options.targetService, { userDid, vcId });

  return {
    signedVP,
    vc,
    agentDid,
    userDid,
    targetService: options.targetService,
    enrollmentExpiresAt: token.expiresAt,
  };
}
