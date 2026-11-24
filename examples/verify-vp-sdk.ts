import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { HelixClient, SessionManager, verifyVP } from '@helixid/sdk-js';
import { createFreshSignedVP } from './verifier-example-utils.js';

// SDK-backed verification + local session demo
//
// Purpose
// - Demonstrates verification via the SDK's `verifyVP()`, which (per the SDK-API-only
//   architecture, docs/proposal-sdk-api-only.md) always calls the API's
//   POST /v1/vp/verify under the hood -- there is no local-only verification path
//   anymore. VP signature, VC signature, validity window, revocation (StatusList),
//   and delegation-chain checks all happen server-side.
// - After a successful verification, issues a short-lived local session JWT using the SDK `SessionManager`
//   (HMAC HS256). It then immediately verifies that session token locally.
//
// Security notes
// - `SessionManager` requires a symmetric secret of at least 16 characters. Set `JWT_SECRET` in `.env` for
//   production. The examples use a demo fallback secret when `JWT_SECRET` is not present — DO NOT use this in
//   production environments.
// - Replay protection is handled server-side: the API logs VP_VERIFIED/VP_REJECTED and enforces
//   single-use VPs, so a verifier calling through the SDK does not need its own replay store.
//
// Env vars used: API_BASE_URL, TARGET_SERVICE, JWT_SECRET (optional for demo), JWT_TTL_SECONDS (optional)

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

const helixApiUrl = process.env.API_BASE_URL ?? 'http://localhost:3000';
const expectedTargetService = process.env.TARGET_SERVICE ?? 'orders-service';

async function main(): Promise<void> {
  const client = new HelixClient(helixApiUrl);
  const fresh = await createFreshSignedVP({
    helixApiUrl,
    targetService: expectedTargetService,
    requiredScope: 'read:orders',
  });

  console.log('[verify-vp-sdk] Verifying a fresh VP via the SDK\'s verifyVP() (POST /v1/vp/verify)');
  console.log(`[verify-vp-sdk] vpId: ${fresh.signedVP.id}`);

  const verified = await verifyVP(fresh.signedVP, client, {
    expectedTargetService,
    allowSelfSigned: false,
  });

  console.log('[verify-vp-sdk] GRANTED');
  console.log(`[verify-vp-sdk] agentDid: ${verified.agentDid}`);
  console.log(`[verify-vp-sdk] delegatedBy(userDid): ${fresh.signedVP.delegatedBy}`);
  console.log(`[verify-vp-sdk] targetService: ${fresh.signedVP.targetService}`);
  console.log(`[verify-vp-sdk] privilegeScopes: ${verified.privilegeScopes.join(', ')}`);
  if (verified.warning) {
    console.log(`[verify-vp-sdk] warning: ${verified.warning}`);
  }

  // Issue and verify a local session JWT using SDK SessionManager (HS256 HMAC)
  const sessionSecret = process.env.JWT_SECRET ?? 'verifier-sdk-demo-secret';
  const sessionTtl = Number(process.env.JWT_TTL_SECONDS ?? 600);
  const session = new SessionManager({ secret: sessionSecret, ttl: sessionTtl });

  const token = await session.issue({
    agentDid: verified.agentDid,
    scopes: verified.privilegeScopes,
    delegationChain: verified.delegationChain ?? [],
  });

  console.log('[verify-vp-sdk] Issued local session token (HMAC)');
  console.log(`[verify-vp-sdk] token (keep secret in production): ${token}`);

  const claims = await session.verify(token);
  console.log('[verify-vp-sdk] Session token verified locally');
  console.log(`[verify-vp-sdk] claims.agentDid: ${claims.agentDid}`);
  console.log(`[verify-vp-sdk] claims.scopes: ${claims.scopes.join(', ')}`);
  console.log(`[verify-vp-sdk] claims.jti: ${claims.jti}`);
  console.log(`[verify-vp-sdk] claims.exp: ${claims.exp}`);
}

main().catch((error: unknown) => {
  console.error('[verify-vp-sdk] DENIED - VP_VERIFICATION_FAILED');
  console.error(
    `[verify-vp-sdk] reason: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
