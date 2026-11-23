// Travel Planner Agent.
//
// The agent keeps its own key (self custody, seed/seed.ts ran helix init):
// it signs every request proof itself; Helix never holds its key. It has no consent
// logic of its own: when an SP answers with the signed needs_authorization
// challenge, the agent checks the SP's response proof and hands the user the
// consent URL, which is Helix's consent page (KYA-OS story L3-H). There the
// user's own did:key signs the root hop of the agent's chain.
//
// The browser flow:
//   1. POST /api/call             -> { status: 'consent_required', consentUrl, pendingId }
//   2. the UI opens consentUrl (Helix's page, on Helix's origin)
//   3. the UI calls POST /api/consent/complete { pendingId }: the agent waits
//      for the user's decision, keeps the signed root hop and retries the call
//      with the resume token and the hop
//
// Step 4 of the demo flow short-circuits all of that: /api/call carries the
// stored hop on the first attempt (renewed without a click when due).
//
// Tool planning is provider-neutral: Gemini, OpenAI, or Anthropic when a key
// is configured, with a deterministic scripted fallback when it is not.

import 'dotenv/config';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ConsentFlowError, kyaos } from '@helixid/sdk-js';
import { AIRLINE, DEMO_SERVICE_USER, HOTEL, agentDir, allowLoopbackHttp, env } from '../helixid-config/index.js';
import { callSpTool, completeConsent, type CallSpToolOptions, type ConsentPrompt } from './consentAwareCall.js';
import { ConsentStore } from './consentStore.js';
import { agentPageHtml } from './web.js';
import {
  createToolPlanner,
  DeterministicPlanner,
  describePlanForHistory,
  phraseQuestion,
  ToolValidationError,
  type ChatContext,
  type PlannerMessage,
} from './gemini.js';
import {
  cityLabel,
  extractSlots,
  mentionsBookingConfirmation,
  mentionsFlight,
  mentionsTripPlanning,
  nextFlightQuestion,
  nextHotelQuestion,
  nextReturnQuestion,
  resolveTrack,
  summariseProfile,
  type ConversationTrack,
  type TripProfile,
} from './conversation.js';

const SP_BY_ID = { airline: AIRLINE, hotel: HOTEL } as const;
const AGENT_USERNAME = 'traveler';
const AGENT_PASSWORD = 'demo123';

function cookies(header: string | undefined): Record<string, string> {
  return Object.fromEntries(
    (header ?? '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((pair) => pair.length === 2),
  );
}

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [agent] ${message}`);
}

/** Each SP's platform-minted did:web, read from its /health -- the SPs must be up before the agent. */
async function resolveSpDids(): Promise<Record<keyof typeof SP_BY_ID, string>> {
  const [airline, hotel] = await Promise.all(
    [env.airlineUrl, env.hotelUrl].map(async (url) => {
      const response = await fetch(`${url}/health`).catch(() => null);
      const body = response?.ok ? ((await response.json()) as { did?: string }) : null;
      if (!body?.did) throw new Error(`SP at ${url} is not up -- start sp:airline and sp:hotel first.`);
      return body.did;
    }),
  );
  return { airline: airline!, hotel: hotel! };
}

/** What the agent already knows, in the plain words a rewrite can reuse. */
function knownFacts(profile: TripProfile): Record<string, string | number> {
  const known: Record<string, string | number> = {};
  if (profile.origin) known['flyingFrom'] = cityLabel(profile.origin);
  if (profile.destination) known['flyingTo'] = cityLabel(profile.destination);
  if (profile.departureDate) known['departureDate'] = profile.departureDate;
  if (profile.returnDate) known['returnDate'] = profile.returnDate;
  if (profile.travelers) known['travellers'] = profile.travelers;
  if (profile.airlinePreference) known['airline'] = profile.airlinePreference;
  if (profile.hotelBudget) known['nightlyBudget'] = profile.hotelBudget;
  return known;
}

async function main(): Promise<void> {
  // helix init's output: the agent's DID and kid (helix-agent.json) and its own key (signing-key.env).
  const dir = agentDir(env.walletsDir);
  const summaryRaw = await readFile(join(dir, 'helix-agent.json'), 'utf8').catch(() => null);
  const keyRaw = await readFile(join(dir, 'signing-key.env'), 'utf8').catch(() => null);
  if (!summaryRaw || !keyRaw) {
    throw new Error(`No agent identity in ${dir}. Run the seeder first: pnpm run setup`);
  }
  const { did: agentDid, kid } = JSON.parse(summaryRaw) as { did: string; kid: string };
  const keyEnv = Object.fromEntries(
    keyRaw.split('\n').filter((line) => line.includes('=') && !line.startsWith('#')).map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]),
  );
  // Self custody: the agent signs its own request proofs; its key never leaves this process.
  const signer = new kyaos.EnvSigner({ did: agentDid, kid: kid.split('#').pop()!, envVar: 'HELIX_SIGNING_KEY', env: keyEnv });
  const consents = new ConsentStore(join(env.walletsDir, 'travel-planner-consents.json'));
  // The SPs' did:web documents are hosted by Helix; a local run serves them on loopback http.
  const resolveDid = kyaos.verifier.createDidResolver(
    allowLoopbackHttp ? { rewriteUrl: (url): string => url.replace(/^https:\/\/(localhost|127\.0\.0\.1)([:/])/, 'http://$1$2') } : {},
  );
  /** Challenged calls waiting for the user's decision on Helix's page. */
  const pendingCalls = new Map<string, { options: CallSpToolOptions; prompt: ConsentPrompt; sp: keyof typeof SP_BY_ID }>();
  const spDids = await resolveSpDids();
  const defaultModels = {
    gemini: 'gemini-2.5-flash',
    openai: 'gpt-4o-mini',
    anthropic: 'claude-sonnet-4-5',
  } as const;
  const planner = env.llmApiKey
    ? createToolPlanner({
        provider: env.llmProvider,
        apiKey: env.llmApiKey,
        model: env.llmModel || defaultModels[env.llmProvider],
      })
    : new DeterministicPlanner();
  // Always available, whatever the configured provider is doing.
  const fallbackPlanner = new DeterministicPlanner();
  log(`agent identity loaded: ${agentDid}`);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const sessions = new Map<string, { serviceUser: string; username: string }>();
  const conversationHistory = new Map<string, PlannerMessage[]>();
  /** What the agent has gathered about the trip, per signed-in session. */
  const tripProfiles = new Map<string, TripProfile>();
  const plannerInfo = { provider: planner.provider, model: planner.model };

  app.get('/', (_req, res) => res.type('html').send(agentPageHtml()));

  app.get('/api/session', (req, res) => {
    const session = sessions.get(cookies(req.headers.cookie)['agent_session'] ?? '');
    res.json(session ? { authenticated: true, ...session, agentDid: agentDid, planner: plannerInfo } : { authenticated: false, planner: plannerInfo });
  });

  app.post('/api/login', (req, res) => {
    const body = req.body as { username?: string; password?: string };
    if (body.username !== AGENT_USERNAME || body.password !== AGENT_PASSWORD) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }
    const token = randomUUID();
    sessions.set(token, { username: AGENT_USERNAME, serviceUser: DEMO_SERVICE_USER });
    conversationHistory.set(token, []);
    res.setHeader('set-cookie', `agent_session=${token}; HttpOnly; SameSite=Lax; Path=/`);
    res.json({ authenticated: true, username: AGENT_USERNAME, serviceUser: DEMO_SERVICE_USER, agentDid: agentDid, planner: plannerInfo });
  });

  app.post('/api/logout', (req, res) => {
    const token = cookies(req.headers.cookie)['agent_session'] ?? '';
    sessions.delete(token);
    conversationHistory.delete(token);
    res.setHeader('set-cookie', 'agent_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.status(204).end();
  });

  app.use('/api', (req, res, next) => {
    if (req.path === '/login' || req.path === '/session') return next();
    const token = cookies(req.headers.cookie)['agent_session'] ?? '';
    const session = sessions.get(token);
    if (!session) {
      res.status(401).json({ error: 'Please log in to the demo agent' });
      return;
    }
    res.locals['agentSessionToken'] = token;
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', agentDid: agentDid, serviceUser: DEMO_SERVICE_USER, llm: plannerInfo });
  });

  /** Appends one exchange to the rolling planner history. */
  function recordTurn(
    token: string,
    history: PlannerMessage[],
    userMessage: string,
    plan: Parameters<typeof describePlanForHistory>[0],
  ): void {
    conversationHistory.set(
      token,
      [
        ...history,
        { role: 'user', content: userMessage },
        { role: 'assistant', content: describePlanForHistory(plan) },
      ].slice(-12) as PlannerMessage[],
    );
  }

  app.post('/api/plan', async (req, res) => {
    const body = req.body as {
      message?: string;
      context?: ChatContext;
      /** Set when the message is a direct answer to the agent's last question. */
      answering?: boolean;
      /** Which search the conversation is currently gathering for. */
      track?: ConversationTrack;
    };
    if (typeof body.message !== 'string' || !body.message.trim()) {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    const token = String(res.locals['agentSessionToken'] ?? '');
    const history = conversationHistory.get(token) ?? [];
    const userMessage = body.message.trim();
    const context = body.context ?? {};

    // ── Conversational gathering ────────────────────────────────────────
    // A real assistant collects what it needs before acting. Slot-filling is
    // resolved here rather than inside a planner so the agent asks the same
    // questions in the same order with or without a model provider — the LLM
    // still handles booking confirmations and free-form chat below.
    const answeringSlot = body.answering === true;
    // Which leg we are on has to be settled before the message is read, because
    // it decides where a bare date lands. See resolveTrack().
    const track = resolveTrack({
      message: userMessage,
      answering: answeringSlot,
      ...(body.track ? { track: body.track } : {}),
    });
    const returning = track === 'return';

    const profile = extractSlots(userMessage, tripProfiles.get(token) ?? {}, { forReturn: returning });
    tripProfiles.set(token, profile);

    const wantsHotel = track === 'hotel';
    const wantsFlight = mentionsFlight(userMessage) || mentionsTripPlanning(userMessage) || returning;
    // Confirming a specific offered option is a booking, never a new search —
    // otherwise "book flight HA733" would re-run the flight search forever.
    const confirmingOption = mentionsBookingConfirmation(userMessage);
    const searchIntent = !confirmingOption && (wantsHotel || wantsFlight || answeringSlot);

    if (searchIntent) {
      const question = track === 'hotel'
        ? nextHotelQuestion(profile)
        : track === 'return'
          ? nextReturnQuestion(profile)
          : nextFlightQuestion(profile);

      if (question) {
        // The engine picked the question; the model only says it better. If the
        // provider is slow or down, phraseQuestion returns the engine's own
        // wording, so the conversation is identical either way.
        const spoken = await phraseQuestion(planner, {
          question: question.question,
          suggestions: question.suggestions,
          known: knownFacts(profile),
        });
        // Worth saying out loud: a silent fallback looks identical to a working
        // rewrite, and on a rate-limited key that is the difference between the
        // agent sounding written and sounding scripted.
        log(
          spoken === question.question
            ? `asking ${question.field} in the engine's own words`
            : `asking ${question.field}, reworded by ${planner.provider}`,
        );
        const ask = {
          kind: 'ask' as const,
          field: question.field,
          message: spoken,
          suggestions: question.suggestions,
        };
        recordTurn(token, history, userMessage, ask);
        res.json({
          ...ask,
          planner: plannerInfo,
          profile,
          summary: summariseProfile(profile),
          track,
        });
        return;
      }

      // Everything needed is known — run the search the user actually asked for.
      const toolPlan = track === 'hotel'
        ? {
            kind: 'tool_call' as const,
            tool: 'search_hotels' as const,
            args: {
              city: profile.destination!,
              maxNightlyRate: String(profile.hotelBudget ?? 0),
              guests: String(profile.travelers ?? 1),
            },
          }
        : {
            kind: 'tool_call' as const,
            tool: 'search_flights' as const,
            args: track === 'return'
              ? {
                  origin: profile.destination!,
                  destination: profile.origin!,
                  departureDate: profile.returnDate!,
                  travelers: String(profile.travelers ?? 1),
                  carrier: profile.airlinePreference ?? 'any',
                }
              : {
                  origin: profile.origin!,
                  destination: profile.destination!,
                  departureDate: profile.departureDate!,
                  travelers: String(profile.travelers ?? 1),
                  carrier: profile.airlinePreference ?? 'any',
                },
          };

      recordTurn(token, history, userMessage, toolPlan);
      log(`gathered details, searching ${toolPlan.tool}`);
      // The track goes back on searches too, so the page never keeps asking
      // against a leg the conversation has already moved off.
      res.json({ ...toolPlan, planner: plannerInfo, profile, summary: summariseProfile(profile), track });
      return;
    }

    let plan: Awaited<ReturnType<typeof planner.plan>>;
    let usedPlanner = plannerInfo;
    try {
      plan = await planner.plan(userMessage, context, history);
    } catch (error) {
      if (error instanceof ToolValidationError) {
        // The model was understood and refused — tell the user plainly rather
        // than retrying somewhere else or leaking a stack trace into chat.
        log(`rejected a planned tool call: ${error.message}`);
        plan = { kind: 'message', message: `${error.message}. Could you restate what you'd like?` };
      } else {
        // The provider itself is unavailable (quota, outage, network). The demo
        // must keep working: fall back to the deterministic planner, which
        // drives the identical validated tool-call and consent path.
        log(`${planner.provider} unavailable, falling back to the scripted planner: ${(error as Error).message}`);
        try {
          plan = await fallbackPlanner.plan(userMessage, context, history);
          usedPlanner = { provider: fallbackPlanner.provider, model: fallbackPlanner.model };
        } catch (fallbackError) {
          const message =
            fallbackError instanceof ToolValidationError
              ? fallbackError.message
              : 'I could not work out what to do next.';
          plan = { kind: 'message', message: `${message}. Could you restate what you'd like?` };
          usedPlanner = { provider: fallbackPlanner.provider, model: fallbackPlanner.model };
        }
      }
    }

    recordTurn(token, history, userMessage, plan);
    log(`${usedPlanner.provider} planned ${plan.kind === 'tool_call' ? plan.tool : 'a text response'}`);
    res.json({
      ...plan,
      planner: usedPlanner,
      profile: tripProfiles.get(token) ?? {},
      summary: summariseProfile(tripProfiles.get(token) ?? {}),
    });
  });

  /** Everything the UI needs to render current authorization state: the root hop the user signed, per SP. */
  app.get('/api/state', async (_req, res) => {
    const grants = await Promise.all(
      Object.values(SP_BY_ID).map(async (sp) => {
        const serviceDid = spDids[sp.id];
        const held = await consents.get(serviceDid);
        return {
          sp: sp.id,
          displayName: sp.displayName,
          serviceDid,
          hasGrant: Boolean(held),
          // What the user consented to, not just that they consented.
          scopes: ((held?.hop['credentialSubject'] as { allowedAction?: string[] } | undefined)?.allowedAction ?? []),
          windowUntil: held ? new Date(held.windowUntil * 1000).toISOString() : null,
          // The user's pairwise did:key at this SP: a different key per SP.
          userDid: held ? (held.hop['issuer'] as string) : null,
        };
      }),
    );
    res.json({ agentDid: agentDid, serviceUser: DEMO_SERVICE_USER, grants });
  });

  app.post('/api/call', async (req, res) => {
    const body = req.body as {
      sp?: 'airline' | 'hotel';
      tool?: string;
      args?: Record<string, unknown>;
    };
    const sp = body.sp ? SP_BY_ID[body.sp] : undefined;
    if (!sp || !body.tool) {
      res.status(400).json({ error: 'sp and tool are required' });
      return;
    }

    const serviceDid = spDids[sp.id];
    // The MCP URL may use a compose-internal hostname.
    const baseUrl = sp.id === 'airline' ? env.airlineUrl : env.hotelUrl;

    // One id per user-initiated action, so the SP's verification / authorization /
    // invocation events all stitch back to it.
    const correlationId = `act_${randomUUID().slice(0, 12)}`;
    const options: CallSpToolOptions = {
      signer,
      agentDid,
      consents,
      serviceUserId: DEMO_SERVICE_USER,
      spMcpUrl: `${baseUrl}/api/mcp`,
      serviceDid,
      toolName: body.tool,
      correlationId,
      resolveDid,
      ...(body.args !== undefined ? { args: body.args } : {}),
    };

    try {
      const result = await callSpTool(options);
      if (result.status === 'consent_required') {
        // The agent does not resolve consent itself: it reports where the user
        // must go (the URL the SP signed), and the UI drives the handoff.
        log(`consent required for ${body.tool} at ${serviceDid}`);
        const pendingId = randomUUID();
        pendingCalls.set(pendingId, { options, prompt: result.prompt, sp: sp.id });
        res.json({ status: 'consent_required', sp: sp.id, serviceDid, consentUrl: result.prompt.authorizationUrl, scopes: result.prompt.scopes, pendingId, correlationId });
        return;
      }
      if (result.status === 'ok') {
        const protectedTool = Boolean(sp.tools.find((tool) => tool.name === body.tool)?.metadata?.requiredScope);
        const authorizationSource = protectedTool ? (result.consentReused ? 'standing_grant' : 'fresh_consent') : 'not_required';
        log(`${body.tool} succeeded (authorizationSource=${authorizationSource})`);
        res.json({ status: 'ok', data: result.data, authorizationSource });
        return;
      }
      res.json({ status: 'error', error: result.error });
    } catch (error) {
      res.status(500).json({ status: 'error', error: { message: (error as Error).message } });
    }
  });

  /**
   * After the UI opened Helix's consent page: waits for the user's decision,
   * keeps the root hop the user's did:key signed, and retries the challenged
   * call with the resume token and that hop.
   */
  app.post('/api/consent/complete', async (req, res) => {
    const { pendingId } = req.body as { pendingId?: string };
    const pending = pendingId ? pendingCalls.get(pendingId) : undefined;
    if (!pending) {
      res.status(404).json({ status: 'error', error: { message: 'no call is waiting for consent' } });
      return;
    }
    pendingCalls.delete(pendingId!);
    try {
      const result = await completeConsent(pending.options, pending.prompt);
      if (result.status === 'ok') {
        log(`${pending.options.toolName} succeeded after consent (authorizationSource=fresh_consent)`);
        res.json({ status: 'ok', data: result.data, authorizationSource: 'fresh_consent' });
        return;
      }
      res.json(result);
    } catch (error) {
      if (error instanceof ConsentFlowError && error.reason === kyaos.consent.ConsentReasons.NOT_APPROVED) {
        log(`consent declined for ${pending.options.toolName} at ${pending.options.serviceDid}`);
        res.json({ status: 'declined' });
        return;
      }
      res.status(500).json({ status: 'error', error: { message: (error as Error).message } });
    }
  });

  app.listen(env.agentPort, '0.0.0.0', () => {
    log(`Travel Planner Agent listening on :${env.agentPort}`);
    log(`agent DID ${agentDid}`);
    log(`acting for the SPs' user ${DEMO_SERVICE_USER}`);
  });
}

main().catch((error: unknown) => {
  console.error('[agent] failed to start:', error);
  process.exit(1);
});
