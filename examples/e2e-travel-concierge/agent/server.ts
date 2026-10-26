// agent — the HTTP surface the web app (and curl, for manual testing) talks to.
//
// Every route below is a building block the guided scenarios in web/index.html
// combine: onboard agents, call a protected tool (as an agent, optionally on a
// traveler's behalf), record a traveler's consent at a service, revoke a
// credential or a consent, delegate between agents, deactivate an agent's DID,
// and three deliberate attacks (replay, tamper, wrong service).
//
// The browser never receives a private key, admin key, or bearer token —
// agent self-custody is retired, so there is no key to receive: the server
// generates and holds it, and every VP is signed via
// POST /v1/agents/:did/vp (see agent/tools/protectedCall.ts).
// This app only keeps local convenience state (a persona manifest and a grant
// index); HelixID remains the source of truth for enrollment, scopes,
// consent, revocation, and audit.
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { runChatTurn } from './chat/runChatTurn.js';
import { LlmError } from './chat/providers/llmError.js';
import { callProtectedTool } from './tools/protectedCall.js';
import { captureAndSend, presentToWrongService, replay, tamperAndSend } from './attacks.js';
import { listServices } from './services.js';
import { SERVICES, USERS, env, type ServiceId, type UserId } from '../config.js';
import { enrollPersona } from '../personas/enroll.js';
import { addGrant, listGrants, markGrantRevoked } from '../personas/grants.js';
import { adminCall, describeApiError } from '../personas/platform.js';
import { addPersona, getPersona, hasPersona, listPersonas, loadPersonas, updatePersona } from '../personas/store.js';
import { toPublic, type Persona } from '../personas/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '1mb' }));
// This example is genuinely dockerless -- no nginx container proxying the
// web UI to this server, unlike e2e-travel-concierge. Serve it directly.
app.use(express.static(join(__dirname, '..', 'web')));

const DELEGATION_PLANNER_ID = 'delegation-planner';
const DELEGATION_RESEARCH_ID = 'delegation-research';
const DELEGATION_SCOPES = ['read:catalog', 'write:orders'];

/** One admin-authenticated call to the self-hosted API. Never throws on a 4xx -- refusals are data here. */
const platform = <T>(path: string, body?: unknown) => adminCall<T>(path, body);

function isUserId(value: unknown): value is UserId {
  return typeof value === 'string' && value in USERS;
}

function requirePersona(res: express.Response, id: unknown): Persona | undefined {
  if (typeof id !== 'string' || !id) {
    res.status(400).json({ error: 'personaId is required' });
    return undefined;
  }
  const persona = getPersona(id);
  if (!persona) res.status(404).json({ error: `Unknown persona: ${id}` });
  return persona;
}

function fail(res: express.Response, error: unknown, fallback: string): void {
  console.error(`[Agent] ${fallback}:`, error);
  res.status(502).json({ success: false, code: fallback.toUpperCase().replace(/\W+/g, '_'), detail: error instanceof Error ? error.message : fallback });
}

app.get('/health', (_req, res) => res.json({ status: 'ok', provider: env.llmProvider }));

// ── Public: discover selectable agents, services and travelers (safe metadata only) ──
app.get('/personas', (_req, res) => {
  res.json({ personas: listPersonas() });
});

app.get('/services', async (_req, res) => {
  try {
    res.json({ services: await listServices() });
  } catch (error) {
    fail(res, error, 'services failed');
  }
});

app.get('/users', (_req, res) => {
  res.json({ users: Object.values(USERS) });
});

// ── Public: chat as a selected persona, optionally on a traveler's behalf ──
app.post('/chat', async (req, res) => {
  const { personaId, message, conversationId, userId } = req.body as {
    personaId?: string;
    message?: string;
    conversationId?: string;
    userId?: string;
  };
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }
  const persona = requirePersona(res, personaId);
  if (!persona) return;
  try {
    const result = await runChatTurn({
      persona,
      message,
      conversationId: conversationId ?? 'default',
      ...(isUserId(userId) ? { userId } : {}),
    });
    return res.json({ ...result, personaId });
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
    return res.status(500).json({ error: 'CHAT_FAILED', message: 'The agent could not complete that request.' });
  }
});

// ── Public: call a protected tool directly, bypassing the LLM entirely ─────
// Signs a fresh VP for the persona and calls the owning service's tool with
// it, same as /chat would after the model decided to call the tool.
app.post('/call-tool', async (req, res) => {
  const { personaId, toolName, input, userId } = req.body as {
    personaId?: string;
    toolName?: string;
    input?: Record<string, unknown>;
    userId?: string;
  };
  if (!toolName || typeof toolName !== 'string') {
    return res.status(400).json({ error: 'toolName is required (search_flights, book_flight, search_hotels, book_hotel)' });
  }
  const persona = requirePersona(res, personaId);
  if (!persona) return;
  try {
    const result = await callProtectedTool(persona, toolName, input ?? {}, isUserId(userId) ? { userId } : {});
    return res.status(result.success ? 200 : 403).json(result);
  } catch (error) {
    return fail(res, error, 'call-tool failed');
  }
});

// ── Public: onboard another agent (enrollment token + POST /v1/onboard) ────
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
  const { personaId, displayName, scopes, maxDelegationDepth, group, token } = req.body as {
    personaId?: string;
    displayName?: string;
    scopes?: string[];
    maxDelegationDepth?: number;
    group?: string;
    /** Optional one-use enrollment token generated in Console; its scopes win over `scopes`. */
    token?: string;
  };
  // An empty array is allowed on purpose: an agent onboarded with no scopes
  // has an identity but no authority of its own (see the delegation scenarios).
  if (!Array.isArray(scopes)) {
    return res.status(400).json({ error: 'scopes is required, e.g. ["read:catalog"], ["read:catalog","write:orders"], or [] for none' });
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
      scopes,
      ...(typeof maxDelegationDepth === 'number' ? { maxDelegationDepth } : {}),
      ...(typeof group === 'string' && group ? { group } : {}),
      ...(typeof token === 'string' && token.trim() ? { bootstrapToken: token.trim() } : {}),
    });
    await addPersona(persona);
    console.log(`[Agent] Onboarded persona "${persona.id}" (${persona.scopes.join(', ') || 'no scopes'}) DID ${did}, VC ${vcId}.`);
    return res.status(201).json({ persona: toPublic(persona) });
  } catch (error) {
    return fail(res, error, 'onboard failed');
  }
});

// ── Organization action: revoke the persona's own credential ───────────────
app.post('/revoke-agent', async (req, res) => {
  const persona = requirePersona(res, (req.body as { personaId?: string }).personaId);
  if (!persona) return;
  try {
    // POST /v1/vcs/:vcId/revoke is admin-gated in OSS.
    const revoked = await platform<{ revokedAt?: string }>(`/v1/vcs/${encodeURIComponent(persona.vcId)}/revoke`);
    if (!revoked.ok) throw new Error(describeApiError(revoked.body.error, revoked.status));
    const revokedAt = revoked.body.revokedAt ?? new Date().toISOString();
    const updated = await updatePersona(persona.id, { revokedAt });
    console.log(`[Agent] Revoked persona "${persona.id}" credential ${persona.vcId}.`);
    return res.json({ success: true, persona: toPublic(updated), vcId: persona.vcId, revoked: true, revokedAt, detail: `Revoked ${persona.displayName}'s credential ${persona.vcId}.` });
  } catch (error) {
    return fail(res, error, 'revoke failed');
  }
});

// ── Organization action: retire the agent's whole identity (its DID) ───────
app.post('/deactivate-agent', async (req, res) => {
  const persona = requirePersona(res, (req.body as { personaId?: string }).personaId);
  if (!persona) return;
  try {
    // Core's DID lifecycle route. Note: a did:key's document is derived from
    // the DID itself, so verifiers never consult the registry for it --
    // deactivating a did:key agent records the fact but can't stop its VPs
    // from verifying. See README "Shipped-capability notes".
    const result = await platform<{ deactivated?: boolean }>(`/v1/dids/${encodeURIComponent(persona.did)}/deactivate`);
    if (!result.ok) {
      return res.status(result.status).json({ success: false, code: result.body.error?.code, detail: describeApiError(result.body.error, result.status) });
    }
    const deactivatedAt = new Date().toISOString();
    const updated = await updatePersona(persona.id, { deactivatedAt });
    console.log(`[Agent] Deactivated persona "${persona.id}" DID ${persona.did}.`);
    return res.json({ success: true, persona: toPublic(updated), detail: `Deactivated ${persona.displayName}'s DID ${persona.did}. Its credential ${persona.vcId} was not revoked.` });
  } catch (error) {
    return fail(res, error, 'deactivate failed');
  }
});

// ── Agent-to-agent delegation ──────────────────────────────────────────────
// POST /v1/agents/:did/delegate signs the delegated VC server-side with the
// delegator's server-held key. `fromDelegated` delegates
// from the credential the delegator was itself delegated (a second hop),
// otherwise from its own onboarding credential.
app.post('/delegate-agent', async (req, res) => {
  const { fromPersonaId, toPersonaId, scopes, expiresIn, fromDelegated } = req.body as {
    fromPersonaId?: string;
    toPersonaId?: string;
    scopes?: string[];
    expiresIn?: number;
    fromDelegated?: boolean;
  };
  if (!fromPersonaId || !toPersonaId || !Array.isArray(scopes) || scopes.length === 0) {
    return res.status(400).json({ error: 'fromPersonaId, toPersonaId and a non-empty scopes array are required' });
  }
  const fromPersona = getPersona(fromPersonaId);
  const toPersona = getPersona(toPersonaId);
  if (!fromPersona) return res.status(404).json({ error: `Unknown persona: ${fromPersonaId}` });
  if (!toPersona) return res.status(404).json({ error: `Unknown persona: ${toPersonaId}` });
  const sourceVcId = fromDelegated ? fromPersona.delegatedVcId : fromPersona.vcId;
  if (!sourceVcId) {
    return res.status(400).json({ success: false, code: 'NO_DELEGATED_CREDENTIAL', detail: `${fromPersona.displayName} holds no delegated credential to delegate from.` });
  }
  const lifetime = typeof expiresIn === 'number' && expiresIn > 0 ? Math.floor(expiresIn) : 3600;

  try {
    const delegated = await platform<{ delegatedVC?: { id: string; validUntil?: string; credentialSubject?: { privilegeScopes?: string[] } } }>(
      `/v1/agents/${encodeURIComponent(fromPersona.did)}/delegate`,
      { to: toPersona.did, scopes, expiresIn: lifetime, vcId: sourceVcId },
    );
    if (!delegated.ok || !delegated.body.delegatedVC) {
      const code = delegated.body.error?.code ?? `HTTP_${delegated.status}`;
      console.log(`[Agent] Delegation ${fromPersona.displayName} → ${toPersona.displayName} [${scopes.join(', ')}] refused: ${code}.`);
      return res.status(delegated.status >= 400 ? delegated.status : 502).json({
        success: false,
        code,
        detail: `Refused by HelixID [${code}]: ${describeApiError(delegated.body.error, delegated.status)}`,
      });
    }
    const vc = delegated.body.delegatedVC;
    const updated = await updatePersona(toPersonaId, {
      delegatedVcId: vc.id,
      delegatedScopes: vc.credentialSubject?.privilegeScopes ?? scopes,
      delegatedBy: fromPersona.displayName,
      ...(vc.validUntil ? { delegationExpiresAt: vc.validUntil } : {}),
    });
    console.log(`[Agent] Delegated ${scopes.join(', ')} from ${fromPersona.displayName} to ${toPersona.displayName} (${lifetime}s).`);
    return res.json({
      success: true,
      persona: toPublic(updated),
      delegatedVcId: vc.id,
      validUntil: vc.validUntil,
      detail: `${fromPersona.displayName} delegated [${scopes.join(', ')}] to ${toPersona.displayName}, valid until ${vc.validUntil ?? 'unknown'}.`,
    });
  } catch (error) {
    return fail(res, error, 'delegation failed');
  }
});

// Kept for the curl test plan in README.md: a fixed Planner/Research pair.
app.post('/delegation-demo-agents', async (_req, res) => {
  try {
    if (!hasPersona(DELEGATION_PLANNER_ID)) {
      const { persona } = await enrollPersona({ id: DELEGATION_PLANNER_ID, displayName: 'Planner Agent', scopes: DELEGATION_SCOPES, maxDelegationDepth: 1 });
      await addPersona(persona);
    }
    if (!hasPersona(DELEGATION_RESEARCH_ID)) {
      const { persona } = await enrollPersona({ id: DELEGATION_RESEARCH_ID, displayName: 'Research Agent', scopes: [] });
      await addPersona(persona);
    }
    return res.json({ plannerPersonaId: DELEGATION_PLANNER_ID, researchPersonaId: DELEGATION_RESEARCH_ID });
  } catch (error) {
    return fail(res, error, 'delegation setup failed');
  }
});

// ── Traveler consent at a service ──────────────────────────────────────────
// The traveler approved on the consent screen; the service (the MCP server
// process, playing the SP) asks the platform to sign the grant with its own
// key. This route only relays the traveler's choice and indexes the result.
app.post('/consent', async (req, res) => {
  const { personaId, userId, serviceId, scopes, durability } = req.body as {
    personaId?: string;
    userId?: string;
    serviceId?: string;
    scopes?: string[];
    durability?: 'standing' | 'session';
  };
  const persona = requirePersona(res, personaId);
  if (!persona) return;
  if (!isUserId(userId)) return res.status(400).json({ error: `userId must be one of ${Object.keys(USERS).join(', ')}` });
  if (!serviceId || !(serviceId in SERVICES)) return res.status(400).json({ error: `serviceId must be one of ${Object.keys(SERVICES).join(', ')}` });
  if (!Array.isArray(scopes) || scopes.length === 0) return res.status(400).json({ error: 'scopes is required' });
  try {
    const spRes = await fetch(`${env.mcpBaseUrl}/sp/${serviceId}/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentDid: persona.did, userDid: USERS[userId].did, scopes, durability }),
    });
    const body = (await spRes.json().catch(() => ({}))) as {
      grant?: { id: string; validFrom: string; validUntil: string; scopes: string[]; durability: 'standing' | 'session' };
      error?: string;
    };
    if (!spRes.ok || !body.grant) {
      return res.status(spRes.status >= 400 ? spRes.status : 502).json({ success: false, code: 'CONSENT_FAILED', detail: body.error ?? `HTTP ${spRes.status}` });
    }
    const record = { ...body.grant, personaId: persona.id, userId, serviceId: serviceId as ServiceId };
    await addGrant(record);
    return res.status(201).json({
      success: true,
      grant: record,
      detail: `${USERS[userId].name} let ${persona.displayName} use [${record.scopes.join(', ')}] at ${SERVICES[serviceId as ServiceId].name.replace(/ \(.*\)$/, '')} (${record.durability}, valid until ${record.validUntil}).`,
    });
  } catch (error) {
    return fail(res, error, 'consent failed');
  }
});

app.get('/grants', async (req, res) => {
  const personaId = typeof req.query.personaId === 'string' ? req.query.personaId : undefined;
  res.json({ grants: await listGrants(personaId) });
});

// The traveler withdraws their consent. Unlike /revoke-agent, the agent's
// own credential is untouched: it can still act on its own authority, and
// for every other traveler who consented.
app.post('/revoke-grant', async (req, res) => {
  const { grantId } = req.body as { grantId?: string };
  if (!grantId) return res.status(400).json({ error: 'grantId is required' });
  try {
    const revoked = await platform<{ revokedAt?: string }>(`/v1/vcs/${encodeURIComponent(grantId)}/revoke`);
    if (!revoked.ok) {
      return res.status(revoked.status).json({ success: false, code: revoked.body.error?.code, detail: describeApiError(revoked.body.error, revoked.status) });
    }
    const grant = await markGrantRevoked(grantId, revoked.body.revokedAt ?? new Date().toISOString());
    return res.json({ success: true, grant, detail: `Consent ${grantId} revoked.` });
  } catch (error) {
    return fail(res, error, 'revoke-grant failed');
  }
});

// ── Attack scenarios ───────────────────────────────────────────────────────
app.post('/attack/capture', async (req, res) => {
  const { personaId, toolName, input } = req.body as { personaId?: string; toolName?: string; input?: Record<string, unknown> };
  const persona = requirePersona(res, personaId);
  if (!persona) return;
  try {
    const { captureId, vpId, result } = await captureAndSend(persona, String(toolName ?? ''), input ?? {});
    return res.status(result.success ? 200 : 403).json({ ...result, captureId, vpId });
  } catch (error) {
    return fail(res, error, 'capture failed');
  }
});

app.post('/attack/replay', async (req, res) => {
  const { captureId } = req.body as { captureId?: string };
  try {
    const result = await replay(String(captureId ?? ''));
    return res.status(result.success ? 200 : 403).json(result);
  } catch (error) {
    return fail(res, error, 'replay failed');
  }
});

app.post('/attack/tamper', async (req, res) => {
  const { personaId, toolName, input, addScopes } = req.body as {
    personaId?: string;
    toolName?: string;
    input?: Record<string, unknown>;
    addScopes?: string[];
  };
  const persona = requirePersona(res, personaId);
  if (!persona) return;
  try {
    const result = await tamperAndSend(persona, String(toolName ?? ''), input ?? {}, Array.isArray(addScopes) ? addScopes : ['write:orders']);
    return res.status(result.success ? 200 : 403).json(result);
  } catch (error) {
    return fail(res, error, 'tamper failed');
  }
});

app.post('/attack/wrong-service', async (req, res) => {
  const { personaId, signFor, toolName, input } = req.body as {
    personaId?: string;
    signFor?: string;
    toolName?: string;
    input?: Record<string, unknown>;
  };
  const persona = requirePersona(res, personaId);
  if (!persona) return;
  if (!signFor || !(signFor in SERVICES)) return res.status(400).json({ error: 'signFor must be air or stay' });
  try {
    const result = await presentToWrongService(persona, signFor as ServiceId, String(toolName ?? ''), input ?? {});
    return res.status(result.success ? 200 : 403).json(result);
  } catch (error) {
    return fail(res, error, 'wrong-service failed');
  }
});

async function start(): Promise<void> {
  await loadPersonas();
  app.listen(env.agentPort, '0.0.0.0', () => {
    console.log(
      `[Agent] Travel concierge listening on :${env.agentPort} ` +
        `(LLM_PROVIDER=${env.llmProvider}, personas: ${listPersonas().length}).`,
    );
  });
}

start().catch((error: unknown) => {
  console.error('[Agent] failed to start:', error);
  process.exit(1);
});
