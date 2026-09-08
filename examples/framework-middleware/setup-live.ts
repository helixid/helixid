import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import {
  agentIdentityPath,
  createHelixClient,
  ensureAgentDirectory,
  helixApiUrl,
  loadAgentCredential,
  logStep,
  readAgentIdentity,
  requestedDomains,
  requestedScopes,
} from './shared.js';

type EnrollmentTokenResponse = {
  token: string;
  expiresAt: string;
};

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${helixApiUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload as T;
}

async function assertApiAvailable(): Promise<void> {
  const response = await fetch(`${helixApiUrl}/health`);
  if (!response.ok) {
    throw new Error(
      `Helix API health check failed with ${response.status}. Start the API before running setup.`,
    );
  }
}

async function main(): Promise<void> {
  await ensureAgentDirectory();

  if (await readAgentIdentity()) {
    logStep('Setup', `Found existing agent identity at ${agentIdentityPath}; skipping onboarding.`);
    const { identity, vc } = await loadAgentCredential();
    const expiresAt = vc.validUntil ?? vc.expirationDate ?? 'unknown';

    logStep('Agent', `DID: ${identity.agentDid}`);
    logStep('Agent', `Selected VC id: ${identity.vcId}`);
    logStep('Agent', `Credential expiry: ${expiresAt}`);
    return;
  }

  await assertApiAvailable();

  logStep('Setup', `Using Helix API at ${helixApiUrl}`);
  logStep('Agent Owner', 'Creating a one-use enrollment token through the live API.');
  const enrollment = await postJson<EnrollmentTokenResponse>('/v1/enrollment-tokens', {
    agentName: 'Framework Middleware Demo Agent',
    requestedScopes,
    requestedDomains,
    maxDelegationDepth: 0,
  });
  logStep('Agent Owner', `Enrollment token expires at ${enrollment.expiresAt}.`);

  const client = createHelixClient();

  // POST /v1/onboard. The server generates the agent's keypair and holds the
  // private key encrypted: no local wallet, no passphrase, and no key material
  // in the response — only the DID and the issued credential's id.
  logStep('Agent', 'Onboarding with Helix API using the enrollment token (POST /v1/onboard).');
  const identity = await client.onboardAgent(enrollment.token, requestedDomains);
  await writeFile(agentIdentityPath, JSON.stringify(identity, null, 2), 'utf8');

  const { vc } = await loadAgentCredential();
  const expiresAt = vc.validUntil ?? vc.expirationDate ?? 'unknown';

  logStep('Helix ID', `Issued VC ${identity.vcId} for ${identity.agentDid}.`);
  logStep('Agent', `Agent identity saved to ${agentIdentityPath} (no key material).`);
  logStep('Agent', `DID: ${identity.agentDid}`);
  logStep('Agent', `Selected VC id: ${identity.vcId}`);
  logStep('Agent', `Scopes: ${requestedScopes.join(', ')}`);
  logStep('Agent', `Credential expiry: ${expiresAt}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
