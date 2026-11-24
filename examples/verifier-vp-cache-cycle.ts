import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { verifyVP } from '@helixid/sdk-js';
import type { SignedVP, VerifyVPResult } from '@helixid/sdk-js';
import { createFreshSignedVP } from './verifier-example-utils.js';

// VP verification cache example
//
// Purpose
// - Demonstrates a verifier-owned cache pattern: verify a VP once using `verifyVP()` and store the
//   verification result keyed by `vpId` until the VP expires. Subsequent presentations of the same VP
//   can be served from cache without repeating cryptographic checks.
//
// Security notes
// - Cache TTL must respect the VP's embedded expiration date. Do not serve cached entries past expiry.
// - Replay protection remains the verifier's responsibility; caching reduces CPU work but does not replace
//   single-use/replay checks.
//
// Env vars used: API_BASE_URL, TARGET_SERVICE

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

const requiredScope = process.env.REQUIRED_SCOPE ?? 'read:orders';
const expectedTargetService = process.env.TARGET_SERVICE ?? 'orders-service';

type CachedVerification = {
  result: VerifyVPResult;
  expiresAtEpochSeconds: number;
};

const verificationCache = new Map<string, CachedVerification>();

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function pruneCache(): void {
  const now = nowSeconds();
  for (const [vpId, entry] of verificationCache.entries()) {
    if (entry.expiresAtEpochSeconds <= now) {
      verificationCache.delete(vpId);
    }
  }
}

async function handleVerifierRequest(vp: SignedVP): Promise<{
  status: number;
  source: 'cache' | 'verify';
  reason?: string;
  claims?: { agentDid: string; scopes: string[]; vpId: string };
}> {
  pruneCache();

  const cached = verificationCache.get(vp.id);
  if (cached) {
    if (!cached.result.privilegeScopes.includes(requiredScope)) {
      return { status: 403, source: 'cache', reason: 'INSUFFICIENT_SCOPE' };
    }

    return {
      status: 200,
      source: 'cache',
      claims: {
        agentDid: cached.result.agentDid,
        scopes: cached.result.privilegeScopes,
        vpId: cached.result.vpId,
      },
    };
  }

  const result = await verifyVP(vp, {
    expectedTargetService,
    allowSelfSigned: false,
  });

  if (!result.privilegeScopes.includes(requiredScope)) {
    return { status: 403, source: 'verify', reason: 'INSUFFICIENT_SCOPE' };
  }

  const vpExpiry = Math.floor(new Date(vp.expirationDate).getTime() / 1000);
  verificationCache.set(vp.id, {
    result,
    expiresAtEpochSeconds: vpExpiry,
  });

  return {
    status: 200,
    source: 'verify',
    claims: {
      agentDid: result.agentDid,
      scopes: result.privilegeScopes,
      vpId: result.vpId,
    },
  };
}

async function main(): Promise<void> {
  const helixApiUrl = process.env.API_BASE_URL ?? 'http://localhost:3000';
  const fresh = await createFreshSignedVP({
    helixApiUrl,
    targetService: expectedTargetService,
    requiredScope,
  });

  console.log('--- First call: VP in -> full verify -> cache write ---');
  const first = await handleVerifierRequest(fresh.signedVP);
  console.log(first);

  console.log('--- Next call: same VP/vpId -> cache hit (no re-verify) ---');
  const second = await handleVerifierRequest(fresh.signedVP);
  console.log(second);

  console.log('--- Cache model notes ---');
  console.log(
    'Verifier owns cache storage, keying strategy (vpId in this example), and TTL policy.',
  );
  console.log('This path is independent of HelixClient and helix-api session JWT issuance.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
