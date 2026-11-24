import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { HelixClient, SessionManager, verifyJWT, verifyVP } from '@helixid/sdk-js';
import { createFreshSignedVP } from './verifier-example-utils.js';

// API session bridge example
//
// Purpose
// - Demonstrates the `session: true` flow: POST `/v1/vp/verify` with `session: true` to request a server-issued
//   session JWT (Ed25519 / EdDSA). The example then fetches `/v1/sessions/public-key` and verifies the
//   EdDSA-signed token locally using `verifyJWT()` from helix-core.
// - Shows a fallback: if the API does not return a session (or denies the VP), the verifier performs local
//   `verifyVP()` and issues a local HS256 session token using SDK `SessionManager`.
//
// Security notes
// - API-issued session tokens are EdDSA-signed; verifiers only need the API session public key to verify them
//   (no shared symmetric secret). This is preferred for cross-service deployments.
// - Local fallback uses a symmetric `JWT_SECRET` and should only be used in single-tenant, controlled setups.
//
// Env vars used: HELIX_MODE (dev|prod), API_BASE_URL, TARGET_SERVICE, JWT_SECRET (optional for local fallback)

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

const mode = (process.env.HELIX_MODE ?? 'dev').toLowerCase();
const configuredBase = process.env.API_BASE_URL ?? 'http://localhost:3000';
const helixApiUrl =
  mode === 'prod'
    ? configuredBase.replace(/^http:\/\//i, 'https://')
    : configuredBase.replace(/^https:\/\//i, 'http://');
const targetService = process.env.TARGET_SERVICE ?? 'amazon';

type VerifyWithSessionResponse = {
  valid: true;
  agentDid: string;
  userDid: string;
  targetService: string;
  verifiedAt: string;
  session?: {
    token: string;
    expiresAt: string;
    publicKeyEndpoint: string;
  };
};

type SessionPublicKeyResponse = {
  publicKeyHex: string;
  publicKeyMultibase: string;
  alg: 'EdDSA';
  crv: 'Ed25519';
};

async function main(): Promise<void> {
  if (mode !== 'dev' && mode !== 'prod') {
    throw new Error(`Unsupported HELIX_MODE: ${mode}. Use "dev" or "prod".`);
  }

  const fresh = await createFreshSignedVP({
    helixApiUrl,
    targetService,
    requiredScope: 'read:orders',
  });

  console.log(`[verify-vp-session-bridge] HELIX_MODE=${mode}`);
  console.log(`[verify-vp-session-bridge] API base: ${helixApiUrl}`);
  console.log('[verify-vp-session-bridge] Calling POST /v1/vp/verify with session=true');
  console.log(`[verify-vp-session-bridge] vpId: ${fresh.signedVP.id}`);

  const response = await fetch(`${helixApiUrl}/v1/vp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signedVP: fresh.signedVP, session: true }),
  });

  const body = (await response.json()) as
    | VerifyWithSessionResponse
    | { error?: { code?: string; message?: string } };
  if (!response.ok) {
    console.log('[verify-vp-session-bridge] API session bridge denied this fresh VP.');
    console.log(`[verify-vp-session-bridge] HTTP ${response.status}`);
    console.log(`[verify-vp-session-bridge] response: ${JSON.stringify(body)}`);
    console.log('[verify-vp-session-bridge] Falling back to verifier-owned local session flow.');

    const client = new HelixClient(helixApiUrl);
    const local = await verifyVP(fresh.signedVP, client, {
      expectedTargetService: targetService,
      allowSelfSigned: false,
    });
    const session = new SessionManager({
      secret: process.env.JWT_SECRET ?? 'verifier-session-bridge-demo-secret',
      ttl: Number(process.env.JWT_TTL_SECONDS ?? 600),
    });
    const token = await session.issue({
      agentDid: local.agentDid,
      scopes: local.privilegeScopes,
      delegationChain: local.delegationChain,
    });
    const claims = await session.verify(token);

    console.log('[verify-vp-session-bridge] GRANTED via local session fallback');
    console.log(`[verify-vp-session-bridge] claims.agentDid: ${claims.agentDid}`);
    console.log(`[verify-vp-session-bridge] claims.scopes: ${claims.scopes.join(', ')}`);
    console.log(`[verify-vp-session-bridge] claims.jti: ${claims.jti}`);
    console.log(`[verify-vp-session-bridge] claims.exp: ${claims.exp}`);
    return;
  }

  const verified = body as VerifyWithSessionResponse;
  console.log('[verify-vp-session-bridge] GRANTED');
  console.log(`[verify-vp-session-bridge] agentDid: ${verified.agentDid}`);
  console.log(`[verify-vp-session-bridge] userDid: ${verified.userDid}`);
  console.log(`[verify-vp-session-bridge] targetService: ${verified.targetService}`);
  console.log(`[verify-vp-session-bridge] verifiedAt: ${verified.verifiedAt}`);

  if (!verified.session?.token) {
    console.log(
      '[verify-vp-session-bridge] No session token returned. Check API session bridge configuration.',
    );
    return;
  }

  const keyUrl = new URL(verified.session.publicKeyEndpoint, helixApiUrl).toString();
  const keyResponse = await fetch(keyUrl);
  if (!keyResponse.ok) {
    throw new Error(`Failed to fetch session public key: HTTP ${keyResponse.status}`);
  }
  const sessionKey = (await keyResponse.json()) as SessionPublicKeyResponse;

  const claims = verifyJWT(verified.session.token, sessionKey.publicKeyHex);
  console.log('[verify-vp-session-bridge] Session JWT issued and verified');
  console.log(`[verify-vp-session-bridge] session.expiresAt: ${verified.session.expiresAt}`);
  console.log(`[verify-vp-session-bridge] jwt.sub(agentDid): ${claims.sub}`);
  console.log(`[verify-vp-session-bridge] jwt.userDid: ${claims.userDid}`);
  console.log(`[verify-vp-session-bridge] jwt.targetService: ${claims.targetService}`);
  console.log(`[verify-vp-session-bridge] jwt.scopes: ${claims.scopes.join(', ')}`);
}

main().catch((error: unknown) => {
  console.error('[verify-vp-session-bridge] DENIED - VP_VERIFICATION_FAILED');
  console.error(
    `[verify-vp-session-bridge] reason: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
