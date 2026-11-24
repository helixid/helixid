// agent — the HTTP surface the web app talks to.
//
// Public surface (browser): GET /personas, POST /chat, POST /onboard-agent,
// POST /revoke-agent and the delegation demo routes, plus POST /call-tool for
// the no-LLM check. The browser may carry a one-time Console-generated
// enrollment token, but it never receives a key, a credential, a request proof
// or the admin key.
//
// KYA-OS throughout (helixid is self custody): each persona's key lives in its
// own key directory on the shared volume, written by helix init; it signs the
// persona's request proofs and the hops it delegates. HelixID remains the
// source of truth for the agents, their attestations, the root hops it issues,
// status lists, revocation and audit; this app keeps the persona manifest.
import 'dotenv/config';
import express from 'express';
import { runChatTurn } from './chat/runChatTurn.js';
import { LlmError } from './chat/providers/llmError.js';
import { callProtectedTool } from './tools/protectedCall.js';
import { SCOPES, env } from '../config.js';
import { HelixError, admin } from '../helixid.js';
import { enrollPersona } from '../personas/enroll.js';
import { delegateHop } from '../personas/keys.js';
import type { Persona } from '../personas/types.js';
import { addPersona, getPersona, hasPersona, listPersonas, loadPersonas, updatePersona } from '../personas/store.js';
import { toPublic } from '../personas/types.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const DELEGATION_SOURCE_ID = 'delegation-planner';
const DELEGATION_TARGET_ID = 'delegation-research';
/** How long Planner's delegation to Research lasts. */
const DELEGATION_SECONDS = 60 * 60;

function refusal(res: express.Response, error: unknown, fallback: string): express.Response {
  console.error(`[Agent] ${fallback}:`, error);
  if (error instanceof HelixError) return res.status(error.status >= 400 ? error.status : 502).json({ error: `${error.code}: ${error.message}`, code: error.code });
  return res.status(502).json({ error: error instanceof Error ? error.message : fallback });
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

// ── Public: consume a Console-generated enrollment token, enroll another agent ──
// helix init runs here: the agent's key is generated in this process and only
// its public key goes to HelixID. Its responsible party then roots its chain at
// the service with what its card attests.
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
    return refusal(res, error, 'onboard failed');
  }
});

// ── Public: call a protected tool directly, without the LLM ───────────────
// Signs the request proof as the persona and calls the MCP tool with its chain,
// exactly as /chat does once the model decided to call the tool.
app.post('/call-tool', async (req, res) => {
  const { personaId, toolName, input } = req.body as { personaId?: string; toolName?: string; input?: Record<string, unknown> };
  const persona = typeof personaId === 'string' ? getPersona(personaId) : undefined;
  if (!persona) return res.status(404).json({ error: `Unknown persona: ${String(personaId)}` });
  if (typeof toolName !== 'string' || !toolName) return res.status(400).json({ error: 'toolName is required (search_flights or book_flight)' });
  try {
    const result = await callProtectedTool(persona, toolName, input ?? {});
    return res.status(result.success ? 200 : 403).json(result);
  } catch (error) {
    return refusal(res, error, 'call-tool failed');
  }
});

// ── Demo admin action: revoke the selected agent ───────────────────────────
// Its identity credential (the revocation entry on its Entity Card) and the root
// hop its responsible party issued, which takes every hop below it: both bits
// flip on the live status lists; the service reads them on the next call.
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
  if (!persona.vcId) return res.status(409).json({ error: `Persona "${personaId}" has no credential to revoke` });

  try {
    const result = await admin<{ revokedAt?: string }>('POST', `/v1/vcs/${encodeURIComponent(persona.vcId)}/revoke`);
    const root = persona.chain?.[0];
    const revokedHops = root ? (await admin<{ revokedVcIds?: string[] }>('DELETE', `/v1/grants/${encodeURIComponent(root.id)}`)).revokedVcIds ?? [root.id] : [];
    const revokedAt = result.revokedAt ?? new Date().toISOString();
    const updated = await updatePersona(persona.id, { revokedAt });
    console.log(`[Agent] Revoked persona "${persona.id}": credential ${persona.vcId} and ${revokedHops.length} hop(s).`);
    return res.json({ persona: toPublic(updated), vcId: persona.vcId, revokedHops, revoked: true, revokedAt });
  } catch (error) {
    return refusal(res, error, 'revoke failed');
  }
});

// ── Use case 4: two agents, and narrowed authority delegated between them ──
async function ensureDelegationPersona(input: { id: string; displayName: string; scopes: string[]; ownAuthority: boolean }): Promise<Persona> {
  const existing = getPersona(input.id);
  if (existing && !existing.revokedAt) {
    // A fresh run starts from the persona's own state: no delegation received.
    if (input.ownAuthority) return existing;
    return updatePersona(existing.id, { chain: undefined, delegatedFromPersonaId: undefined, delegatedScopes: undefined });
  }
  const { persona, vcId, did } = await enrollPersona(input);
  if (existing) {
    const { id: _id, ...fresh } = persona;
    void _id;
    return updatePersona(existing.id, { ...fresh, chain: persona.chain, revokedAt: undefined, statusList: undefined, delegatedFromPersonaId: undefined, delegatedScopes: undefined });
  }
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
      ownAuthority: true,
    });
    // Attested for both scopes, but no authority of its own at the service: without a delegation it can do nothing there.
    const target = await ensureDelegationPersona({
      id: DELEGATION_TARGET_ID,
      displayName: 'Research Agent',
      scopes: [SCOPES.FLIGHTS_READ, SCOPES.FLIGHTS_BOOK],
      ownAuthority: false,
    });
    return res.status(201).json({ source: toPublic(source), target: toPublic(target) });
  } catch (error) {
    return refusal(res, error, 'delegation setup failed');
  }
});

interface DelegateBody {
  fromPersonaId?: string;
  toPersonaId?: string;
  scopes?: string[];
}

// The delegator signs a hop to the target under the chain it holds, with its
// own key, on its own status list (KYA-OS: a self-custody subject signs its own
// hops). The target then carries the chain root → delegator → target; its
// authority is its attestations ∩ that last hop.
app.post('/delegate-agent', async (req, res) => {
  const body = req.body as DelegateBody;
  const fromPersonaId = body.fromPersonaId || DELEGATION_SOURCE_ID;
  const toPersonaId = body.toPersonaId || DELEGATION_TARGET_ID;
  const scopes = Array.isArray(body.scopes) && body.scopes.length > 0 ? body.scopes : [SCOPES.FLIGHTS_READ];

  const fromPersona = getPersona(fromPersonaId);
  const toPersona = getPersona(toPersonaId);
  if (!fromPersona) return res.status(404).json({ error: `Unknown source persona: ${fromPersonaId}` });
  if (!toPersona) return res.status(404).json({ error: `Unknown target persona: ${toPersonaId}` });
  const parent = fromPersona.chain;
  const held = new Set(parent?.[parent.length - 1]?.credentialSubject.allowedAction ?? []);
  if (!parent || !scopes.every((scope) => held.has(scope))) {
    return res.status(409).json({
      error: `${fromPersona.displayName} holds no authority to delegate ${scopes.join(', ')}. Click "Create demo agents" to refresh the demo agents, then delegate again.`,
      code: 'SCOPE_ESCALATION_DENIED',
    });
  }

  try {
    const validUntil = new Date(Math.min(Date.now() + DELEGATION_SECONDS * 1000, Date.parse(parent[parent.length - 1]!.validUntil))).toISOString();
    const { hop, statusList } = await delegateHop(fromPersona, parent, { invoker: toPersona.agentDid, allowedAction: scopes, validUntil });
    const updatedSource = await updatePersona(fromPersona.id, { statusList });
    const updatedTarget = await updatePersona(toPersona.id, {
      chain: [...parent, hop],
      delegatedFromPersonaId: fromPersona.id,
      delegatedScopes: scopes,
    });
    console.log(`[Agent] Delegated ${scopes.join(', ')} from "${fromPersona.id}" to "${toPersona.id}" with hop ${hop.id}.`);
    return res.json({ from: toPublic(updatedSource), to: toPublic(updatedTarget), delegatedHopId: hop.id, scopes, validUntil });
  } catch (error) {
    return refusal(res, error, 'delegation failed');
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
