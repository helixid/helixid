// agent — the HTTP surface the web app talks to.
//
// Public surface (browser): GET /personas, POST /chat, POST /onboard-agent, and
// POST /revoke-agent for the guided revocation demo. The browser may carry a
// one-time Console-generated onboarding token, but it never receives a wallet,
// VC, VP, private key, admin key, or persisted credential material.
//
// Runtime onboarding consumes a token minted by HelixID Console. This app only
// keeps local persona convenience state (manifest + encrypted wallet); HelixID
// remains the source of truth for enrollment, scopes, revocation, and audit.
import 'dotenv/config';
import express from 'express';
import { HelixClient } from '@helixid/sdk-js';
import type { SignedVC } from '@helixid/sdk-js';
import { runChatTurn } from './chat/runChatTurn.js';
import { LlmError } from './chat/providers/llmError.js';
import { SCOPES, env } from '../config.js';
import { enrollPersona } from '../personas/enroll.js';
import { addPersona, getPersona, hasPersona, listPersonas, loadPersonas, updatePersona } from '../personas/store.js';
import { toPublic } from '../personas/types.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const DELEGATION_SOURCE_ID = 'delegation-planner';
const DELEGATION_TARGET_ID = 'delegation-research';

function vcScopes(vc: SignedVC): string[] {
  const subject = vc.credentialSubject as { privilegeScopes?: unknown };
  return Array.isArray(subject.privilegeScopes)
    ? subject.privilegeScopes.filter((scope): scope is string => typeof scope === 'string')
    : [];
}

function vcMaxDelegationDepth(vc: SignedVC): number {
  const subject = vc.credentialSubject as { maxDelegationDepth?: unknown };
  return typeof subject.maxDelegationDepth === 'number' ? subject.maxDelegationDepth : 0;
}

function vcDelegationDepth(vc: SignedVC): number {
  const subject = vc.credentialSubject as { delegationDepth?: unknown };
  return typeof subject.delegationDepth === 'number' ? subject.delegationDepth : 0;
}

function credentialMatches(vc: SignedVC, scopes: string[], maxDelegationDepth: number): boolean {
  const availableScopes = vcScopes(vc);
  const expectedScopes = new Set(scopes);
  return (
    availableScopes.length === scopes.length &&
    availableScopes.every((scope) => expectedScopes.has(scope)) &&
    vcMaxDelegationDepth(vc) >= maxDelegationDepth
  );
}

function isIssuerBackedRootCredential(vc: SignedVC): boolean {
  return vc.issuer !== vc.credentialSubject.id && vcDelegationDepth(vc) === 0;
}

function canSatisfyDelegationPersona(vc: SignedVC, scopes: string[], maxDelegationDepth: number): boolean {
  if (!credentialMatches(vc, scopes, maxDelegationDepth)) return false;
  return maxDelegationDepth <= 0 || isIssuerBackedRootCredential(vc);
}

/**
 * Every active credential the platform holds for an agent.
 *
 * Replaces reading wallet.credentials: agent self-custody is retired, so the
 * platform is the only place a persona's credentials exist. listVCs() returns
 * summaries without a credentialSubject, so each is read back in full.
 */
async function activeCredentials(client: HelixClient, agentDid: string): Promise<SignedVC[]> {
  const summaries = await client.listVCs({ subjectDid: agentDid, status: 'active' });
  const credentials: SignedVC[] = [];
  for (const summary of summaries) {
    const vc = (await client.getVC(summary.vcId)).vc as SignedVC | undefined;
    if (vc) credentials.push(vc);
  }
  return credentials;
}

function findDelegationSourceCredential(credentials: SignedVC[], scopes: string[]): SignedVC | undefined {
  const candidates = credentials.filter((vc) => {
    const availableScopes = new Set(vcScopes(vc));
    return (
      scopes.every((scope) => availableScopes.has(scope)) &&
      vcDelegationDepth(vc) + 1 <= vcMaxDelegationDepth(vc)
    );
  });
  return candidates.find(isIssuerBackedRootCredential) ?? candidates[0];
}

app.get('/health', (_req, res) => res.json({ status: 'ok', provider: env.llmProvider }));

// ── Public: discover selectable agents (safe metadata only) ────────────────
app.get('/personas', (_req, res) => {
  res.json({ personas: listPersonas() });
});

// ── Public: chat as a selected persona ─────────────────────────────────────
interface ChatRequestBody {
  personaId?: string;
  message?: string;
  conversationId?: string;
}

app.post('/chat', async (req, res) => {
  const { personaId, message, conversationId } = req.body as ChatRequestBody;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }
  if (!personaId || typeof personaId !== 'string') {
    return res.status(400).json({ error: 'personaId is required' });
  }
  const persona = getPersona(personaId);
  if (!persona) {
    return res.status(404).json({ error: `Unknown persona: ${personaId}` });
  }
  try {
    const reply = await runChatTurn({
      persona,
      message,
      conversationId: conversationId ?? 'default',
    });
    return res.json({ reply, personaId });
  } catch (error) {
    if (error instanceof LlmError) {
      console.error(`[Agent] chat turn failed: ${error.provider} ${error.code}`, error.cause);
      return res.status(error.httpStatus).json({
        error: error.code,
        message: error.userMessage,
        provider: error.provider,
        retryAfterSeconds: error.retryAfterSeconds,
      });
    }
    console.error('[Agent] chat turn failed:', error);
    return res.status(500).json({
      error: 'CHAT_FAILED',
      message: 'The agent could not complete that request.',
    });
  }
});

// ── Public: consume a Console-generated token and enroll another agent ─────
interface OnboardBody {
  personaId?: string;
  displayName?: string;
  bootstrapToken?: string;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(slug) ? slug : `agent-${slug || Date.now()}`;
}

function uniquePersonaId(base: string): string {
  if (!hasPersona(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!hasPersona(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

app.post('/onboard-agent', async (req, res) => {
  const { personaId, displayName, bootstrapToken } = req.body as OnboardBody;
  if (!bootstrapToken || typeof bootstrapToken !== 'string') {
    return res.status(400).json({ error: 'bootstrapToken is required' });
  }

  const resolvedDisplayName =
    typeof displayName === 'string' && displayName.trim()
      ? displayName.trim()
      : `Agent ${new Date().toISOString().slice(11, 19)}`;
  const resolvedPersonaId =
    typeof personaId === 'string' && personaId.trim()
      ? personaId.trim()
      : uniquePersonaId(slugify(resolvedDisplayName));

  if (!/^[a-z][a-z0-9-]*$/.test(resolvedPersonaId)) {
    return res.status(400).json({ error: 'personaId must match ^[a-z][a-z0-9-]*$' });
  }
  if (hasPersona(resolvedPersonaId)) {
    return res.status(409).json({ error: `persona "${resolvedPersonaId}" already exists` });
  }

  try {
    const { persona, vcId, did } = await enrollPersona({
      id: resolvedPersonaId,
      displayName: resolvedDisplayName,
      scopes: [],
      bootstrapToken,
    });
    await addPersona(persona);
    console.log(`[Agent] Onboarded persona "${persona.id}" (${persona.scopes.join(', ')}) DID ${did}, VC ${vcId}.`);
    return res.status(201).json({ persona: toPublic(persona) });
  } catch (error) {
    console.error('[Agent] onboard failed:', error);
    return res.status(502).json({ error: error instanceof Error ? error.message : 'onboard_failed' });
  }
});

// ── Demo admin action: revoke the selected persona's real credential ───────
interface RevokeBody {
  personaId?: string;
}

app.post('/revoke-agent', async (req, res) => {
  const { personaId } = req.body as RevokeBody;
  if (!personaId || typeof personaId !== 'string') {
    return res.status(400).json({ error: 'personaId is required' });
  }

  const persona = getPersona(personaId);
  if (!persona) {
    return res.status(404).json({ error: `Unknown persona: ${personaId}` });
  }

  try {
    const client = new HelixClient(env.helixApiUrl, { adminApiKey: env.adminApiKey });
    const vc = (await activeCredentials(client, persona.agentDid))[0];
    if (!vc?.id) {
      return res.status(409).json({ error: `Persona "${personaId}" has no credential to revoke` });
    }

    const result = await client.revokeVC(vc.id);
    console.log(`[Agent] Revoked persona "${persona.id}" credential ${vc.id}.`);
    return res.json({
      persona: toPublic(persona),
      vcId: vc.id,
      revoked: true,
      revokedAt: result.revokedAt ?? new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Agent] revoke failed:', error);
    return res.status(502).json({ error: error instanceof Error ? error.message : 'revoke_failed' });
  }
});

// ── Use case 4: create two agents and delegate narrowed authority ──────────
async function ensureDelegationPersona(input: {
  id: string;
  displayName: string;
  scopes: string[];
  maxDelegationDepth: number;
}) {
  const existing = getPersona(input.id);
  if (existing) {
    const client = new HelixClient(env.helixApiUrl, { adminApiKey: env.adminApiKey });
    const matchingCredential = (await activeCredentials(client, existing.agentDid)).find((vc) =>
      canSatisfyDelegationPersona(vc, input.scopes, input.maxDelegationDepth),
    );
    if (matchingCredential) {
      if (
        existing.activeCredentialId !== matchingCredential.id ||
        existing.delegatedFromPersonaId ||
        existing.delegatedScopes?.length
      ) {
        return updatePersona(existing.id, {
          scopes: input.scopes,
          activeCredentialId: matchingCredential.id,
          delegatedFromPersonaId: undefined,
          delegatedScopes: undefined,
        });
      }
      return existing;
    }
    const { persona, vcId, did } = await enrollPersona(input);
    const updated = await updatePersona(existing.id, {
      scopes: persona.scopes,
      activeCredentialId: vcId,
      delegatedFromPersonaId: undefined,
      delegatedScopes: undefined,
    });
    console.log(`[Agent] Refreshed delegation demo persona "${updated.id}" DID ${did}, VC ${vcId}.`);
    return updated;
  }

  const { persona, vcId, did } = await enrollPersona(input);
  await addPersona(persona);
  console.log(`[Agent] Created delegation demo persona "${persona.id}" DID ${did}, VC ${vcId}.`);
  return persona;
}

app.post('/delegation-demo-agents', async (_req, res) => {
  try {
    const source = await ensureDelegationPersona({
      id: DELEGATION_SOURCE_ID,
      displayName: 'Planner Agent',
      scopes: [SCOPES.FLIGHTS_READ, SCOPES.FLIGHTS_BOOK],
      maxDelegationDepth: 1,
    });
    const target = await ensureDelegationPersona({
      id: DELEGATION_TARGET_ID,
      displayName: 'Research Agent',
      scopes: [],
      maxDelegationDepth: 0,
    });

    return res.status(201).json({ source: toPublic(source), target: toPublic(target) });
  } catch (error) {
    console.error('[Agent] delegation demo setup failed:', error);
    return res.status(502).json({ error: error instanceof Error ? error.message : 'delegation_setup_failed' });
  }
});

interface DelegateBody {
  fromPersonaId?: string;
  toPersonaId?: string;
  scopes?: string[];
}

app.post('/delegate-agent', async (req, res) => {
  const body = req.body as DelegateBody;
  const fromPersonaId = body.fromPersonaId || DELEGATION_SOURCE_ID;
  const toPersonaId = body.toPersonaId || DELEGATION_TARGET_ID;
  const scopes = Array.isArray(body.scopes) && body.scopes.length > 0 ? body.scopes : [SCOPES.FLIGHTS_READ];

  const fromPersona = getPersona(fromPersonaId);
  const toPersona = getPersona(toPersonaId);
  if (!fromPersona) return res.status(404).json({ error: `Unknown source persona: ${fromPersonaId}` });
  if (!toPersona) return res.status(404).json({ error: `Unknown target persona: ${toPersonaId}` });

  try {
    // delegateAuthority() authorizes the API to sign on the delegator's
    // behalf. The wallet-based delegate() needed the delegator's own private
    // key, which no longer exists anywhere outside the server.
    const client = new HelixClient(env.helixApiUrl, { adminApiKey: env.adminApiKey });
    const fromVC = findDelegationSourceCredential(
      await activeCredentials(client, fromPersona.agentDid),
      scopes,
    );
    if (!fromVC) {
      return res.status(409).json({
        error:
          `${fromPersona.displayName} does not have a credential that can delegate ${scopes.join(', ')}. ` +
          'Click "Create demo agents" to refresh the demo credentials, then delegate again.',
      });
    }
    // The delegated credential is persisted by the platform as part of
    // finalizing it, so there is nothing to store on the target's side.
    const childVC = await client.delegateAuthority(
      fromPersona.agentDid,
      toPersona.agentDid,
      scopes,
      60 * 60,
      { vcId: fromVC.id },
    );

    const updatedTarget = await updatePersona(toPersona.id, {
      activeCredentialId: childVC.id,
      delegatedFromPersonaId: fromPersona.id,
      delegatedScopes: scopes,
    });

    console.log(
      `[Agent] Delegated ${scopes.join(', ')} from "${fromPersona.id}" to "${toPersona.id}" via ${childVC.id}.`,
    );
    return res.json({
      from: toPublic(fromPersona),
      to: toPublic(updatedTarget),
      delegatedCredentialId: childVC.id,
      scopes,
    });
  } catch (error) {
    console.error('[Agent] delegation failed:', error);
    return res.status(502).json({ error: error instanceof Error ? error.message : 'delegation_failed' });
  }
});

async function start(): Promise<void> {
  await loadPersonas();
  app.listen(env.agentPort, '0.0.0.0', () => {
    console.log(
      `[Agent] Travel concierge listening on :${env.agentPort} ` +
        `(LLM_PROVIDER=${env.llmProvider}, personas: ${listPersonas().map((p) => p.id).join(', ') || 'none'}).`,
    );
  });
}

start().catch((error: unknown) => {
  console.error('[Agent] failed to start:', error);
  process.exit(1);
});
