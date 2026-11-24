import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { createFreshSignedVP } from './verifier-example-utils.js';

// Path 1: API verification. This script mints a fresh credential and VP for each run,
// then verifies via POST /v1/vp/verify.
//
// Purpose
// - Demonstrates API-backed verification: the verifier posts a signed VP to
//   `POST /v1/vp/verify` and expects a cryptographically verified response.
//
// Notes
// - The example treats the API as the canonical verifier and does not perform a
//   SDK fallback. If you configured the API to accept stateless VP presentations,
//   the verifier remains responsible for replay protection (storing `vpId`).
// - Env vars used: API_BASE_URL, TARGET_SERVICE

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

const helixApiUrl = process.env.API_BASE_URL ?? 'http://localhost:3000';
const targetService = process.env.TARGET_SERVICE ?? 'amazon';

type VerifySuccess = {
  valid: true;
  agentDid: string;
  userDid: string;
  targetService: string;
  verifiedAt: string;
};

type VerifyError = {
  error?: {
    code?: string;
    message?: string;
  };
};

async function main(): Promise<void> {
  const fresh = await createFreshSignedVP({
    helixApiUrl,
    targetService,
    requiredScope: 'read:orders',
  });

  console.log('[Verifier] Created fresh VP for API verification');
  console.log(`[Verifier] Agent DID: ${fresh.agentDid}`);
  console.log(`[Verifier] VC id: ${fresh.vc.id}`);
  console.log(`[Verifier] vpId: ${fresh.signedVP.id}`);
  console.log(`[Verifier] targetService: ${fresh.targetService}`);

  const response = await fetch(`${helixApiUrl}/v1/vp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signedVP: fresh.signedVP }),
  });

  const body = (await response.json()) as VerifySuccess | VerifyError;
  if (response.ok) {
    const verified = body as VerifySuccess;
    console.log('[Verifier] GRANTED via API /v1/vp/verify');
    console.log(`[Verifier] Agent DID: ${verified.agentDid}`);
    console.log(`[Verifier] User DID: ${verified.userDid}`);
    console.log(`[Verifier] Target service: ${verified.targetService}`);
    console.log(`[Verifier] Scopes: ${fresh.vc.credentialSubject.privilegeScopes.join(', ')}`);
    console.log(`[Verifier] Credential expiry: ${fresh.vc.validUntil}`);
    console.log(`[Verifier] Verified at: ${verified.verifiedAt}`);
    console.log(`[Verifier] Presented vpId: ${fresh.signedVP.id}`);
    return;
  }

  // No SDK-only fallback. If the API can't verify, treat as a verification failure.
  console.log('[Verifier] DENIED - VP_VERIFICATION_FAILED');
  console.log(`[Verifier] Helix API response: ${JSON.stringify(body)}`);
  console.log("[Verifier] External response to caller: { error: 'VP_VERIFICATION_FAILED' }");
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('[Verifier] DENIED - VP_VERIFICATION_FAILED');
  console.error(
    `[Verifier] Internal reason: ${error instanceof Error ? error.message : String(error)}`,
  );
  console.error("[Verifier] External response to caller: { error: 'VP_VERIFICATION_FAILED' }");
  process.exitCode = 1;
});
