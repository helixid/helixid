import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SignedVP, VerifyVPResult } from '@helixid/sdk-js';
import { HelixClient, verifyVP } from '@helixid/sdk-js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const exampleRoot = __dirname;
/**
 * Where setup records the agent's onboarding result.
 *
 * Agent self-custody is retired: onboarding returns only { agentDid, vcId }
 * and the key never leaves the server, so there is no wallet file and no
 * passphrase. This identity file replaces both.
 */
export const agentIdentityPath = join(exampleRoot, 'agent', 'agent.json');
export const helixApiUrl = process.env.API_BASE_URL ?? 'http://localhost:3000';
/** signVP() is admin-key gated in OSS/core, so the agent process needs this. */
export const adminApiKey = process.env.HELIX_ADMIN_API_KEY ?? 'dev-admin-key-change-in-production';
export const targetService = process.env.HELIX_TARGET_SERVICE ?? 'amazon';
export const userDid = process.env.HELIX_USER_DID ?? 'did:hedera:testnet:user-framework-middleware-demo';
export const requestedScopes = ['read:orders', 'write:orders', 'read:catalog'];
export const requestedDomains = ['https://framework-middleware.example.com'];

export type VerificationWithScopes = VerifyVPResult & {
  scopes: string[];
  privilegeScopes: string[];
  /** Optional on the VP itself — a presentation need not name an end user. */
  userDid: string | undefined;
  targetService: string;
};

export type WalletVC = {
  id: string;
  validUntil?: string;
  expirationDate?: string;
  credentialSubject?: {
    privilegeScopes?: unknown;
  };
};

export function createHelixClient(): HelixClient {
  return new HelixClient(helixApiUrl, { adminApiKey });
}

export async function ensureAgentDirectory(): Promise<void> {
  await mkdir(dirname(agentIdentityPath), { recursive: true });
}

export interface AgentIdentity {
  agentDid: string;
  vcId: string;
}

/** The agent's recorded onboarding result, or null before setup has run. */
export async function readAgentIdentity(): Promise<AgentIdentity | null> {
  try {
    return JSON.parse(await readFile(agentIdentityPath, 'utf8')) as AgentIdentity;
  } catch {
    return null;
  }
}

export async function requireAgentIdentity(): Promise<AgentIdentity> {
  const identity = await readAgentIdentity();
  if (!identity) {
    throw new Error(
      `No agent identity at ${agentIdentityPath}. Run pnpm example:middleware:setup first.`,
    );
  }
  return identity;
}

/** The agent's credential, read back from the platform that holds it. */
export async function loadAgentCredential(): Promise<{
  identity: AgentIdentity;
  vc: WalletVC;
}> {
  const identity = await requireAgentIdentity();
  const client = createHelixClient();
  const vc = (await client.getVC(identity.vcId)).vc as WalletVC | undefined;
  if (!vc) {
    throw new Error(`Credential ${identity.vcId} was not found on the API.`);
  }
  return { identity, vc };
}

export function decodeHelixVP(encoded: unknown): SignedVP {
  if (typeof encoded !== 'string') {
    throw new Error('Expected a base64url encoded Helix VP string');
  }
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedVP;
}

export function encodeHelixVP(signedVP: SignedVP): string {
  return Buffer.from(JSON.stringify(signedVP), 'utf8').toString('base64url');
}

export function extractScopes(signedVP: SignedVP): string[] {
  const [credential] = signedVP.verifiableCredential as Array<WalletVC | undefined>;
  const scopes = credential?.credentialSubject?.privilegeScopes;
  return Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === 'string') : [];
}

export async function verifyWithScopes(signedVP: SignedVP): Promise<VerificationWithScopes> {
  // Verification is API-mediated, so it needs a client like everything else here.
  const verified = await verifyVP(signedVP, createHelixClient());
  const scopes = extractScopes(signedVP);
  return {
    ...verified,
    scopes,
    privilegeScopes: scopes,
    userDid: signedVP.delegatedBy,
    targetService: signedVP.targetService,
  };
}

export function logStep(actor: string, message: string): void {
  console.log(`[${actor}] ${message}`);
}
