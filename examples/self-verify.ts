import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import {
  base58btcDecode,
  getBit,
  hashCanonicalPayload,
  multibaseToPublicKeyHex,
  verifySignature,
} from '@helixid/sdk-js';
import { createFreshSignedVP } from './verifier-example-utils.js';

// Use self-verification when the verifier cannot or does not want to call
// POST /v1/vp/verify for every request. The tradeoff is sharp: you now own
// VP signature checks, VC signature checks, DID resolution, expiry, StatusList
// revocation, target service binding, delegatedBy validation, and replay storage.
// Missing one check is a security gap.

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

const helixApiUrl = process.env.API_BASE_URL ?? 'http://localhost:3000';
const targetService = process.env.TARGET_SERVICE ?? 'amazon';
const issuerPublicKeyHexFromEnv = process.env.HELIX_ISSUER_PUBLIC_KEY;

type Proof = {
  proofValue: string;
};

function proofToSignatureHex(proofValue: string): string {
  const raw = proofValue.startsWith('z') ? proofValue.slice(1) : proofValue;
  return Buffer.from(base58btcDecode(raw)).toString('hex');
}

async function verifyProof(
  payload: Record<string, unknown>,
  proof: Proof,
  publicKeyHex: string,
): Promise<boolean> {
  const hash = hashCanonicalPayload(payload);
  return verifySignature(hash, proofToSignatureHex(proof.proofValue), publicKeyHex);
}

function publicKeyFromDidDocument(didDocument: {
  verificationMethod?: Array<{ type?: string; publicKeyHex?: string; publicKeyMultibase?: string }>;
}): string {
  const method = didDocument.verificationMethod?.find((item) => item.type?.includes('Ed25519'));
  if (!method) throw new Error('DID document has no Ed25519 verification method');
  if (method.publicKeyHex) return method.publicKeyHex;
  if (method.publicKeyMultibase) return multibaseToPublicKeyHex(method.publicKeyMultibase);
  throw new Error('DID document has no public key material');
}

function fail(step: string, reason: string): never {
  console.log(`[Self Verify] ${step}: FAIL - ${reason}`);
  console.log(`[Self Verify] NOT TRUSTED`);
  process.exit(1);
}

async function resolveDidDocument(did: string): Promise<{
  verificationMethod?: Array<{ type?: string; publicKeyHex?: string; publicKeyMultibase?: string }>;
}> {
  // Direct did:web resolution: transform the DID into the issuer's did.json URL
  // and fetch it directly. This avoids calling the Helix API for DID resolution
  // and keeps self-verification general-purpose.
  if (!did.startsWith('did:web:')) {
    throw new Error(`Unsupported DID method for direct fetch resolver: ${did}`);
  }

  const parts = did.split(':');
  const decoded = parts.slice(2).map(decodeURIComponent);
  let [host, ...pathParts] = decoded;
  if (!host) throw new Error(`Invalid did:web DID: ${did}`);

  // Compatibility: accept legacy/local did:web forms like did:web:localhost:3000
  // and did:web:127.0.0.1:3000 where port was not percent-encoded.
  function isLoopbackHost(hostname: string): boolean {
    const normalized = hostname.toLowerCase();
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
  }

  if (isLoopbackHost(host) && pathParts.length > 0 && /^\d+$/.test(pathParts[0] ?? '')) {
    host = `${host}:${pathParts[0]}`;
    pathParts = pathParts.slice(1);
  }

  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    throw new Error(`Invalid did:web DID: ${did}`);
  }

  const path =
    pathParts.length === 0 ? '/.well-known/did.json' : `/${pathParts.join('/')}/did.json`;
  const scheme = isLoopbackHost(hostname) ? 'http' : 'https';
  const url = `${scheme}://${host}${path}`;

  const didResponse = await fetch(url, {
    headers: { accept: 'application/did+json, application/json' },
  });
  if (!didResponse.ok) {
    throw new Error(
      `DID resolution failed for ${did} with HTTP ${didResponse.status} when fetching ${url}`,
    );
  }
  const doc = (await didResponse.json()) as {
    id?: string;
    verificationMethod?: Array<{
      type?: string;
      publicKeyHex?: string;
      publicKeyMultibase?: string;
    }>;
  };
  if (!doc || doc.id !== did) {
    throw new Error(`Invalid or mismatched DID document for ${did}`);
  }
  return doc;
}

async function resolvePublicKeyHex(did: string): Promise<string> {
  if (did.startsWith('did:key:')) {
    const multibase = did.slice('did:key:'.length);
    return multibaseToPublicKeyHex(multibase);
  }
  const didDocument = await resolveDidDocument(did);
  return publicKeyFromDidDocument(didDocument);
}

async function main(): Promise<void> {
  console.log('[Self Verify] Step 1 - Create fresh VP');
  const fresh = await createFreshSignedVP({
    helixApiUrl,
    targetService,
    requiredScope: 'read:orders',
  });
  const signedVP = fresh.signedVP;
  const vc = signedVP.verifiableCredential[0];
  console.log(`  agent DID: ${signedVP.holder}`);
  console.log(`  user DID delegatedBy: ${signedVP.delegatedBy}`);
  console.log(`  vpId: ${signedVP.id}`);
  console.log(`  nonce: ${signedVP.nonce}`);
  console.log(`  VP expires at: ${signedVP.expirationDate}`);
  console.log(`  VC id: ${vc.id}`);

  console.log('[Self Verify] Step 2 - Check VP expiry');
  if (new Date(signedVP.expirationDate).getTime() <= Date.now()) {
    fail('Step 2', 'VP expired. VPs are short-lived; create a new one and retry.');
  }
  console.log('  PASS');

  // Resolve the holder public key. `did:key` is resolved locally. `did:web` is
  // resolved by fetching the issuer's did.json directly from the issuer host.
  console.log('[Self Verify] Step 3 - Resolve agent verification key');
  const agentPublicKeyHex = await resolvePublicKeyHex(signedVP.holder).catch((error) =>
    fail('Step 3', error instanceof Error ? error.message : String(error)),
  );
  console.log(`  resolved public key: ${agentPublicKeyHex}`);

  // Trust chain: the agent signed the VP, Helix ID signed the VC, and Hedera
  // anchored the DID. These are separate checks with separate keys.
  console.log('[Self Verify] Step 4 - Verify VP signature');
  const { proof: vpProof, ...vpPayload } = signedVP;
  if (!(await verifyProof(vpPayload, vpProof, agentPublicKeyHex))) {
    fail('Step 4', 'VP signature invalid');
  }
  console.log('  PASS');

  // Preferred: provide HELIX_ISSUER_PUBLIC_KEY. For demo convenience, this
  // script falls back to resolving the issuer DID document when env is absent.
  console.log('[Self Verify] Step 5 - Verify VC signature');
  // Resolve issuer public key: prefer environment override, otherwise resolve issuer DID
  let issuerPublicKeyHex: string | undefined = issuerPublicKeyHexFromEnv;
  if (!issuerPublicKeyHex) {
    try {
      issuerPublicKeyHex = await resolvePublicKeyHex(vc.issuer);
    } catch (error) {
      fail('Step 5', error instanceof Error ? error.message : String(error));
    }
  }
  const { proof: vcProof, ...vcPayload } = vc;
  if (!(await verifyProof(vcPayload, vcProof, issuerPublicKeyHex))) {
    fail('Step 5', 'VC signature invalid');
  }
  console.log('  PASS');

  console.log('[Self Verify] Step 6 - Check VC expiry');
  if (new Date(vc.validUntil).getTime() <= Date.now()) {
    fail('Step 6', 'credential expired');
  }
  console.log('  PASS');

  // delegatedBy is the userDID of the user on whose behalf the agent acts. A
  // real verifier should check it against its own user/session records.
  console.log('[Self Verify] Step 7 - Check delegatedBy');
  console.log(`  delegatedBy: ${signedVP.delegatedBy}`);
  console.log('  PASS - demo accepts the simulated user DID');

  // This is the remaining network dependency. BitstringStatusList is embedded in the
  // VC and points at the issuer's status endpoint. Do not skip it: a valid VP
  // from a revoked credential is still invalid.
  console.log('[Self Verify] Step 8 - Check BitstringStatusList revocation');
  const statusRes = await fetch(vc.credentialStatus.statusListCredential);
  if (!statusRes.ok) fail('Step 8', `StatusList fetch failed with HTTP ${statusRes.status}`);
  const statusList = (await statusRes.json()) as { credentialSubject: { encodedList: string } };
  const bit = getBit(
    statusList.credentialSubject.encodedList,
    Number(vc.credentialStatus.statusListIndex),
  );
  if (bit === 1) fail('Step 8', 'credential revoked');
  console.log(`  PASS - bit ${bit} at index ${vc.credentialStatus.statusListIndex}`);

  // Replay tracking is the verifier's responsibility when self-verifying.
  // If your Helix API is configured to be stateless (or you don't call POST /v1/vp/verify),
  // your verifier must record presented vpIds and reject replays. Example pseudocode:
  // if (await store.has(vpId)) reject('replay detected');
  // await store.set(vpId, true, { ttl: untilCredentialExpiry });
  console.log('[Self Verify] Step 9 - vpId replay protection');
  console.log(
    `  CHECK REQUIRED - record ${signedVP.id} in your verifier store and reject it if seen again.`,
  );

  console.log('[Self Verify] Step 10 - Final verdict');
  console.log('[Self Verify] TRUSTED');
  console.log(`  agent DID: ${signedVP.holder}`);
  console.log(`  user DID: ${signedVP.delegatedBy}`);
  console.log(
    `  credentialSubject.privilegeScopes: ${vc.credentialSubject.privilegeScopes.join(', ')}`,
  );
  console.log(`  credential expiry: ${vc.validUntil}`);
  console.log(`  vpId obligation: ${signedVP.id} must be stored as consumed by this verifier.`);
  console.log(
    '[Self Verify] Foundation for a no-runtime-Helix verification library; next add DID and StatusList caching.',
  );
  console.log('[Self Verify] BitstringStatusList: https://www.w3.org/TR/vc-bitstring-status-list/');
}

main().catch((error: unknown) => {
  console.error(
    `[Self Verify] NOT TRUSTED - ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
