import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { generateKeyPair, publicKeyToMultibase, signData } from '@helixid/sdk-js';

// Expiry is planned and known in advance. Revocation is immediate and event
// driven: consent changes, key compromise, incorrect scopes, or anomalous agent
// behavior may require stopping a credential before it naturally expires.

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

const DEFAULT_SCOPES = ['read:catalog', 'write:orders', 'read:inventory'];
const helixApiUrl = process.env.API_BASE_URL ?? 'http://localhost:3000';
const adminKey = process.env.HELIX_ADMIN_API_KEY;

function readStatusListBit(encodedList: string, index: number): 0 | 1 {
  const compressed = Buffer.from(encodedList.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const buffer = gunzipSync(compressed);
  const byteIndex = Math.floor(index / 8);
  const bitIndex = index % 8;
  const byte = buffer[byteIndex];
  if (byte === undefined) throw new Error('Status list index out of bounds');
  return ((byte >> (7 - bitIndex)) & 1) === 1 ? 1 : 0;
}

type SignedVC = {
  id: string;
  validFrom: string;
  validUntil: string;
  credentialStatus: {
    statusListIndex: string;
    statusListCredential: string;
  };
  credentialSubject: {
    id: string;
    privilegeScopes: string[];
    agentName: string;
  };
};

async function checkStatus(vc: SignedVC): Promise<{ bit: 0 | 1; status: 'ACTIVE' | 'REVOKED' }> {
  const response = await fetch(vc.credentialStatus.statusListCredential);
  if (!response.ok) throw new Error(`StatusList fetch failed with HTTP ${response.status}`);
  const statusList = (await response.json()) as { credentialSubject: { encodedList: string } };
  const bit = readStatusListBit(
    statusList.credentialSubject.encodedList,
    Number(vc.credentialStatus.statusListIndex),
  );
  return { bit, status: bit === 0 ? 'ACTIVE' : 'REVOKED' };
}

async function revoke(vcId: string): Promise<void> {
  if (!adminKey) throw new Error('HELIX_ADMIN_API_KEY is required to revoke a credential.');
  const response = await fetch(`${helixApiUrl}/v1/vcs/${encodeURIComponent(vcId)}/revoke`, {
    method: 'POST',
    headers: { 'x-admin-api-key': adminKey },
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`Revocation failed with HTTP ${response.status}: ${await response.text()}`);
  }
}

async function createEnrollmentToken(scopes: string[]): Promise<string> {
  const response = await fetch(`${helixApiUrl}/v1/enrollment-tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agentName: 'E2E Travel Concierge Renewed',
      requestedScopes: scopes,
      requestedDomains: ['https://travel-concierge.example.com'],
      maxDelegationDepth: 0,
    }),
  });
  if (!response.ok)
    throw new Error(
      `Enrollment token failed with HTTP ${response.status}: ${await response.text()}`,
    );
  const body = (await response.json()) as { token: string };
  return body.token;
}

function bootstrapProofPayload(input: {
  bootstrapToken: string;
  agentDid: string;
  timestamp: number;
}): string {
  return JSON.stringify({
    bootstrapToken: input.bootstrapToken,
    agentDid: input.agentDid,
    timestamp: input.timestamp,
  });
}

async function enrollNewCredential(scopes: string[]): Promise<{ vc: SignedVC; did: string }> {
  const bootstrapToken = await createEnrollmentToken(scopes);
  const keyPair = generateKeyPair();
  const agentDid = `did:key:${publicKeyToMultibase(keyPair.publicKey)}`;
  const timestamp = Date.now();
  const proofSignature = signData(
    bootstrapProofPayload({ bootstrapToken, agentDid, timestamp }),
    keyPair.privateKey,
  );

  const response = await fetch(`${helixApiUrl}/v1/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrapToken, agentDid, timestamp, proofSignature }),
  });
  if (!response.ok) {
    throw new Error(`Enroll failed with HTTP ${response.status}: ${await response.text()}`);
  }

  const result = (await response.json()) as { vc: SignedVC };
  return { did: agentDid, vc: result.vc };
}

async function main(): Promise<void> {
  console.log('[Agent Owner] Creating fresh enrollment token and onboarding a test credential.');
  const initial = await enrollNewCredential(DEFAULT_SCOPES);
  const vc = initial.vc;

  console.log('[Verifier] Scenario 1 - Active credential');
  // BitstringStatusList is a compressed bitstring. The VC carries a URL and index;
  // the verifier fetches the URL and checks one bit. The list reveals positions,
  // not credential IDs, which is more private than a plain revocation list.
  const before = await checkStatus(vc);
  console.log(`[Verifier] Credential status: ${before.status}`);
  console.log(`[Verifier] Credential ID: ${vc.id}`);
  console.log(`[Verifier] StatusList index checked: ${vc.credentialStatus.statusListIndex}`);
  console.log(`[Verifier] Bit value: ${before.bit} (${before.status.toLowerCase()})`);
  console.log(`[Verifier] Credential issued at: ${vc.validFrom}`);
  console.log(`[Verifier] Credential expires at: ${vc.validUntil}`);

  console.log('\n[Verifier] Scenario 2 - Revoke and re-check');
  // In production this is the agent owner's action, not the verifier's. Revoke
  // immediately when consent is withdrawn, a private key is compromised, scopes
  // were issued incorrectly, or agent behavior is anomalous.
  console.log(`[Agent Owner] Revoking credential: ${vc.id}`);
  await revoke(vc.id);
  const after = await checkStatus(vc);
  console.log('[Helix ID] Credential revoked. StatusList bit set to 1.');
  console.log(`[Verifier] Credential status: ${after.status}`);
  console.log(`[Verifier] Bit value: ${after.bit} (${after.status.toLowerCase()})`);
  console.log("[Verifier] External response to agent: { error: 'VP_VERIFICATION_FAILED' }");
  // Revocation is immediate for Path 1 API verification and Path 3 self-verify.
  // Session JWT verifiers may not see revocation until a pre-existing JWT expires
  // (up to the configured 10-minute TTL in the default setup).

  console.log('\n[Verifier] Scenario 3 - Repeated VP verification after revocation');
  // This script is VP-only (no JWT session bridge): each presentation checks
  // revocation status, so a revoked credential is denied immediately every time.
  for (const presentation of [1, 2, 3, 4]) {
    const check = await checkStatus(vc);
    const decision = check.bit === 1 ? 'DENIED' : 'GRANTED';
    console.log(`[Verifier] VP Presentation ${presentation}: checking... ${decision}`);
    console.log(`           Internal reason: StatusList bit = ${check.bit} (${check.status})`);
    if (check.bit === 1) {
      console.log("           External response to agent: { error: 'VP_VERIFICATION_FAILED' }");
    }
  }

  console.log('\n[Verifier] Scenario 4 - Renewal after revocation');
  // The DID is not the credential. Revoking a credential does not erase the
  // agent identity. Current onboarding issues a new credential to a new
  // DID; the old VC remains revoked and the new VC receives a fresh list index.
  console.log('[Agent Owner] Creating replacement enrollment token.');
  const renewed = await enrollNewCredential(vc.credentialSubject.privilegeScopes);
  const oldStatus = await checkStatus(vc);
  const newStatus = await checkStatus(renewed.vc);
  console.log(
    `[Verifier] Old VC (${vc.id}): StatusList index ${vc.credentialStatus.statusListIndex} bit = ${oldStatus.bit} ${oldStatus.status}`,
  );
  console.log(
    `[Verifier] New VC (${renewed.vc.id}): StatusList index ${renewed.vc.credentialStatus.statusListIndex} bit = ${newStatus.bit} ${newStatus.status}`,
  );
  console.log(`[Verifier] Original agent DID: ${initial.did}`);
  console.log(`[Verifier] Replacement agent DID: ${renewed.did}`);
  console.log('[Verifier] The old VC remains permanently revoked; the replacement VC is active.');
  console.log('[Verifier] BitstringStatusList: https://www.w3.org/TR/vc-bitstring-status-list/');
}

main().catch((error: unknown) => {
  console.error(`[Revocation Check] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
