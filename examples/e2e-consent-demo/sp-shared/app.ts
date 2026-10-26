// One Service Provider app. Both demo SPs are this same shape — only the tool
// catalog and scope strings differ (Epic 5 Part C).
//
// This single app owns all four SP responsibilities:
//   C1  POST /api/mcp                    MCP endpoint (tools/list + tools/call)
//   C2  GET  /api/consent/scopes         scope resolution for the widget
//   C3  POST /api/consent/accept         grant issuance — signs with the SP's key
//   C4  the booking handlers behind C1's scope gate
//
// plus the two artifacts an SP must host for anyone to verify its grants:
//   GET /.well-known/did.json            its did:web document
//   GET /status-list/1                   its Bitstring status list
//
// The SP's private key lives only in this process. The browser never sees it;
// grant signing happens exclusively inside POST /api/consent/accept.

import express, { type Express, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import {
  buildDIDDocument,
  HelixClient,
  issueGrant,
  verifyVP,
  AuditEvents,
  type SignedVC,
  type SignedVP,
} from '@helixid/sdk-js';
import { resolveConsentScopes } from '@helixid/widget/server';
import type { SpDefinition } from '../helixid-config/index.js';
import { statusListUrlFor } from '../helixid-config/index.js';
import type { SpStore } from './store.js';
import type { AuditEmitter } from './audit.js';

export interface SpIssuer {
  did: string;
  privateKeyHex: string;
  publicKeyHex: string;
}

export interface SpAppOptions {
  definition: SpDefinition;
  issuer: SpIssuer;
  /** Public base URL this SP is reachable at — must match its did:web host. */
  baseUrl: string;
  /**
   * Where the shared helix-api instance lives. VP verification is always an
   * API call (the SDK-API-only design) -- even for an SP with its own
   * independent did:web identity, verifying a *presented* VP means resolving
   * and checking a chain of DIDs, VCs and revocation state that the SP itself
   * doesn't own, so it goes through the one shared verifier rather than each
   * SP re-implementing verification locally.
   */
  helixApiUrl: string;
  store: SpStore;
  /**
   * Where this SP's own MCP endpoint lives, for the scope resolver to read
   * tool metadata from. Defaults to this app's own /api/mcp.
   */
  mcpServerUrl?: string;
  /** Absolute path to @helixid/widget's dist, served to the consent page. */
  widgetDistPath?: string;
  /**
   * Where this SP reports its own activity events. Optional — with no sink
   * configured the SP behaves exactly as before, just without an audit trail.
   */
  audit?: AuditEmitter;
}

/** Test-visible counters. Part D's step-5 assertion reads these. */
export interface SpCounters {
  /** Times issueGrant() actually ran (i.e. POST /api/consent/accept succeeded). */
  grantsIssued: number;
  /** Times the widget resolved its scope catalog — one per consent render. */
  scopeResolutions: number;
  /** Times a tool call was refused for want of a grant. */
  consentRequired: number;
}

export interface SpApp {
  app: Express;
  counters: SpCounters;
  definition: SpDefinition;
  issuerDid: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

function jsonRpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonRpcError(
  id: unknown,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

export function createSpApp(options: SpAppOptions): SpApp {
  const { definition, issuer, baseUrl, store } = options;
  const statusListUrl = statusListUrlFor(baseUrl);
  const mcpServerUrl = options.mcpServerUrl ?? `${baseUrl}/api/mcp`;
  const helixClient = new HelixClient(options.helixApiUrl);

  const counters: SpCounters = { grantsIssued: 0, scopeResolutions: 0, consentRequired: 0 };

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const browserSessions = new Set<string>();

  function browserSession(req: Request): string | undefined {
    const raw = req.headers.cookie ?? '';
    const value = raw.split(';').map((part) => part.trim()).find((part) => part.startsWith('sp_session='))?.slice('sp_session='.length);
    return value && browserSessions.has(value) ? value : undefined;
  }

  const log = (message: string): void => {
    console.log(`[${new Date().toISOString()}] [${definition.id}] ${message}`);
  };

  const audit: AuditEmitter = options.audit ?? { emit: () => undefined };

  // ── Hosted identity artifacts ──────────────────────────────────────────
  // Both are required for anyone to verify a grant this SP issued: the DID
  // document to check its signature, the status list to check revocation.

  app.get('/.well-known/did.json', (_req, res) => {
    res.json(buildDIDDocument(issuer.did, issuer.publicKeyHex));
  });

  app.get('/status-list/:listId', (_req, res) => {
    res.json(store.getStatusList());
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      sp: definition.id,
      did: issuer.did,
      statusListUrl,
      tools: definition.tools.map((tool) => tool.name),
    });
  });

  // ── C2: scope resolution for the consent widget ────────────────────────

  app.get('/api/consent/scopes', async (req: Request, res: Response) => {
    // `agentDid` is retained for AUDIT CORRELATION only. It is deliberately NOT
    // passed into resolveConsentScopes() and must not affect the returned
    // catalog: this SP advertises its full scope catalog to every agent. Do not
    // delete this parameter as "unused" — the route contract requires it, and
    // Part H's "full catalog regardless of agentDid" assertion depends on it
    // staying. (Register D4. The audit sink it will correlate into is parked
    // under D2 and does not exist yet.)
    const agentDid = String(req.query['agentDid'] ?? '');
    log(`consent scopes requested (agentDid=${agentDid || 'none'})`);

    counters.scopeResolutions += 1;
    try {
      const scopeOptions = await resolveConsentScopes({
        mcpServerUrl,
        curatedFallback: definition.curatedFallback,
      });
      res.json({ scopeOptions });
    } catch (error) {
      res.status(500).json({
        error: { code: 'SCOPE_RESOLUTION_FAILED', message: (error as Error).message },
      });
    }
  });

  // ── C3: grant issuance ─────────────────────────────────────────────────

  app.post('/api/consent/accept', async (req: Request, res: Response) => {
    const body = req.body as {
      agentDid?: string;
      userDid?: string;
      scopes?: string[];
      durability?: 'standing' | 'session';
      /** Optional — stitches issuance into the tool call that prompted it. */
      correlationId?: string;
    };

    if (!body.agentDid || !body.userDid || !Array.isArray(body.scopes) || !body.durability) {
      res.status(400).json({
        error: { code: 'INVALID_REQUEST', message: 'agentDid, userDid, scopes and durability are required' },
      });
      return;
    }

    // UX13: the SP does not trust the client — a caller that bypasses the
    // widget entirely (posts straight to this route) must still be held to
    // the same catalog rules the widget enforces client-side. Re-resolve the
    // catalog server-side and reject any selection missing a required scope
    // (e.g. accept-terms) rather than silently issuing a grant for it.
    try {
      const scopeOptions = await resolveConsentScopes({
        mcpServerUrl,
        curatedFallback: definition.curatedFallback,
      });
      const missingRequired = scopeOptions
        .filter((option) => option.required)
        .map((option) => option.scope)
        .filter((scope) => !body.scopes!.includes(scope));
      if (missingRequired.length > 0) {
        res.status(400).json({
          error: {
            code: 'MISSING_REQUIRED_SCOPE',
            message: `Selection is missing required scope(s): ${missingRequired.join(', ')}`,
            missingRequired,
          },
        });
        return;
      }
    } catch (error) {
      res.status(500).json({
        error: { code: 'SCOPE_RESOLUTION_FAILED', message: (error as Error).message },
      });
      return;
    }

    try {
      // The SP signs with its own key, in this process. This is the custodial
      // boundary: the browser posts a selection, never a signature.
      const { grantVC, updatedStatusList } = await issueGrant(
        {
          agentDid: body.agentDid,
          userDid: body.userDid,
          scopes: body.scopes,
          durability: body.durability,
          serviceDid: issuer.did,
          statusList: store.getStatusList(),
          statusListCredentialUrl: statusListUrl,
        },
        { did: issuer.did, privateKeyHex: issuer.privateKeyHex },
        helixClient,
      );

      // Persist BOTH — the grant so this SP can revoke by VC later, the status
      // list so the allocated index survives a restart.
      await store.recordGrant(
        {
          grantVC,
          agentDid: body.agentDid,
          userDid: body.userDid,
          scopes: body.scopes,
          durability: body.durability,
          issuedAt: new Date().toISOString(),
        },
        updatedStatusList,
      );

      counters.grantsIssued += 1;
      log(`grant issued to ${body.agentDid} for ${body.userDid} [${body.scopes.join(', ')}]`);
      // Issuer-side record. The agent emits CONSENT_GRANTED when the credential
      // lands in its wallet; this is the other half — what this SP actually
      // signed, for whom, and with what authority.
      audit.emit({
        event: AuditEvents.VC_ISSUED,
        correlationId: body.correlationId,
        agentDid: body.agentDid,
        userDid: body.userDid,
        vcId: grantVC.id,
        credentialType: 'DelegationGrantCredential',
        issuer: issuer.did,
        scopes: body.scopes,
        validUntil: grantVC.validUntil,
        credentialStatus: 'active',
        result: 'success',
        resultSummary: `Consent grant issued for ${body.scopes.join(', ')}`,
      });
      res.status(201).json({ grantVC });
    } catch (error) {
      res.status(500).json({
        error: { code: 'GRANT_ISSUANCE_FAILED', message: (error as Error).message },
      });
    }
  });

  // ── C1 + C4: MCP endpoint and the booking handlers behind it ───────────

  app.post('/api/mcp', async (req: Request, res: Response) => {
    const rpc = req.body as JsonRpcRequest;

    if (rpc.method === 'tools/list') {
      // Shape the scope resolver reads: name/description plus optional
      // metadata.requiredScope. Search tools carry none (register D7).
      res.json(
        jsonRpcResult(rpc.id, {
          tools: definition.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            ...(tool.metadata !== undefined ? { metadata: tool.metadata } : {}),
          })),
        }),
      );
      return;
    }

    if (rpc.method !== 'tools/call') {
      res.json(jsonRpcError(rpc.id, -32601, `Method not found: ${String(rpc.method)}`));
      return;
    }

    const toolName = rpc.params?.name ?? '';
    const args = rpc.params?.arguments ?? {};
    const tool = definition.tools.find((entry) => entry.name === toolName);
    if (!tool) {
      res.json(jsonRpcError(rpc.id, -32602, `Unknown tool: ${toolName}`));
      return;
    }

    const requiredScope = tool.metadata?.requiredScope;
    const correlationId =
      typeof args['_helixCorrelationId'] === 'string' ? args['_helixCorrelationId'] : undefined;

    // Open, read-only tools run with no presentation and no scope check.
    // This is what guarantees step 2 of the demo never prompts for consent.
    if (!requiredScope) {
      log(`OPEN    ${toolName}`);
      const output = runTool(toolName, args, 'anonymous');
      // Still recorded: "the agent searched" is part of the activity story, and
      // the trail should make plain that this needed no credential at all.
      audit.emit({
        event: AuditEvents.TOOL_INVOKED,
        correlationId,
        toolName,
        result: 'success',
        resultSummary: summarizeToolResult(toolName, output),
        reason: 'OPEN_TOOL_NO_SCOPE_REQUIRED',
      });
      res.json(jsonRpcResult(rpc.id, { structuredContent: output }));
      return;
    }

    const vp = args['_helixVP'] as SignedVP | undefined;
    if (!vp) {
      counters.consentRequired += 1;
      log(`DENIED  ${toolName}  no presentation supplied`);
      audit.emit({
        event: AuditEvents.AUTHZ_DENIED,
        correlationId,
        toolName,
        requiredScope,
        result: 'blocked',
        reason: 'NO_PRESENTATION',
        // Worded as a request, not a refusal: nobody has asked the user yet,
        // and this response is what raises the consent prompt.
        resultSummary: `${toolName} needs consent — no credential presented`,
      });
      res.json(
        jsonRpcError(rpc.id, -32001, 'Consent required', {
          code: 'CONSENT_REQUIRED',
          reason: 'NO_PRESENTATION',
          requiredScope,
          serviceDid: issuer.did,
          consentUrl: `${baseUrl}/consent`,
        }),
      );
      return;
    }

    // From here the agent has actually presented something. Record that as its
    // own fact, before saying anything about whether it holds up.
    const presentedCredentials = Array.isArray(vp.verifiableCredential)
      ? (vp.verifiableCredential as SignedVC[])
      : [];
    audit.emit({
      event: AuditEvents.VC_PRESENTED,
      correlationId,
      agentDid: typeof vp.holder === 'string' ? vp.holder : undefined,
      userDid: typeof vp.delegatedBy === 'string' ? vp.delegatedBy : undefined,
      vpId: typeof vp.id === 'string' ? vp.id : undefined,
      credentialType: presentedCredentials
        .map((entry) => (Array.isArray(entry.type) ? entry.type : []).find((t) => t !== 'VerifiableCredential'))
        .filter((t): t is string => typeof t === 'string')
        .join(' + '),
      toolName,
      requiredScope,
      result: 'success',
      resultSummary: `Presented ${presentedCredentials.length} credential(s) to ${definition.displayName}`,
    });

    let effectiveScopes: string[];
    let agentDid: string;
    try {
      // One verification implementation: the SDK's verifyVP(), which is always
      // an API call to the shared helix-api (the SDK-API-only design). It
      // checks the agent VC, the grant (agent-match AND user-match), both
      // signatures, both validity windows, and revocation — failing closed on
      // any of them.
      const result = await verifyVP(vp, helixClient, { expectedTargetService: issuer.did });
      effectiveScopes = result.effectiveScopes;
      agentDid = result.agentDid;
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'VP_VERIFICATION_FAILED';
      log(`DENIED  ${toolName}  verification failed (${code})`);
      audit.emit({
        event: AuditEvents.VP_REJECTED,
        correlationId,
        agentDid: typeof vp.holder === 'string' ? vp.holder : undefined,
        vpId: typeof vp.id === 'string' ? vp.id : undefined,
        toolName,
        requiredScope,
        result: 'failure',
        reason: code,
        resultSummary: `Verification failed (${code})`,
      });
      res.json(
        jsonRpcError(rpc.id, -32002, 'Presentation could not be verified', {
          code: 'VP_INVALID',
          reason: code,
        }),
      );
      return;
    }

    // Cryptographically sound. Everything after this is policy, not crypto —
    // which is exactly why it gets its own events.
    audit.emit({
      event: AuditEvents.VP_VERIFIED,
      correlationId,
      agentDid,
      userDid: typeof vp.delegatedBy === 'string' ? vp.delegatedBy : undefined,
      vpId: typeof vp.id === 'string' ? vp.id : undefined,
      toolName,
      requiredScope,
      effectiveScopes,
      result: 'success',
      resultSummary: 'Signatures, validity and revocation all checked out',
    });

    // A scoped tool at this SP requires the End User's consent, which means a
    // grant THIS SP issued must actually be in the presentation.
    //
    // Checking effectiveScopes alone is not sufficient and it is worth being
    // explicit about why: per the VP design, effectiveScopes collapses to the
    // agent's own privilegeScopes when no grant is present, and the agent VC
    // must itself carry `book:flights` for a grant to have any effect (the
    // intersection is bounded by the agent's ceiling). So an agent presenting
    // only its platform-issued VC would clear an effectiveScopes check while
    // never having asked the user anything. Requiring the grant entry is what
    // makes consent load-bearing rather than decorative.
    const grantFromThisSp = (vp.verifiableCredential as SignedVC[]).find(
      (entry) =>
        Array.isArray(entry.type) &&
        (entry.type as string[]).includes('DelegationGrantCredential') &&
        entry.issuer === issuer.did,
    );
    if (!grantFromThisSp) {
      counters.consentRequired += 1;
      log(`DENIED  ${toolName}  agent ${agentDid} verified but presented no grant from this SP`);
      audit.emit({
        event: AuditEvents.AUTHZ_DENIED,
        correlationId,
        agentDid,
        userDid: typeof vp.delegatedBy === 'string' ? vp.delegatedBy : undefined,
        toolName,
        requiredScope,
        effectiveScopes,
        result: 'blocked',
        reason: 'NO_GRANT_FOR_THIS_SERVICE',
        // Expected on an agent's first call to this SP. The credential is
        // sound; the user simply has not authorized this service yet, so the
        // agent is sent to the consent page and retries.
        resultSummary: `${toolName} needs consent — credential verified, but this user has not yet authorized ${definition.displayName}`,
      });
      res.json(
        jsonRpcError(rpc.id, -32001, 'Consent required', {
          code: 'CONSENT_REQUIRED',
          reason: 'NO_GRANT_FOR_THIS_SERVICE',
          requiredScope,
          serviceDid: issuer.did,
          consentUrl: `${baseUrl}/consent`,
        }),
      );
      return;
    }

    // effectiveScopes is the enforcement field: the intersection of the agent's
    // own authority and the user's consent grant. Reading privilegeScopes here
    // would ignore the grant entirely.
    if (!effectiveScopes.includes(requiredScope)) {
      counters.consentRequired += 1;
      log(`DENIED  ${toolName}  agent ${agentDid} verified but lacks ${requiredScope}`);
      // The demo's sharpest moment: a perfectly valid credential, refused
      // because the user never granted this particular power.
      audit.emit({
        event: AuditEvents.AUTHZ_DENIED,
        correlationId,
        agentDid,
        userDid: typeof vp.delegatedBy === 'string' ? vp.delegatedBy : undefined,
        vcId: grantFromThisSp.id,
        toolName,
        requiredScope,
        effectiveScopes,
        result: 'blocked',
        reason: 'INSUFFICIENT_EFFECTIVE_SCOPE',
        resultSummary: `${toolName} blocked — required scope "${requiredScope}" not present in [${effectiveScopes.join(', ')}]`,
      });
      res.json(
        jsonRpcError(rpc.id, -32001, 'Consent required', {
          code: 'CONSENT_REQUIRED',
          reason: 'INSUFFICIENT_EFFECTIVE_SCOPE',
          requiredScope,
          serviceDid: issuer.did,
          consentUrl: `${baseUrl}/consent`,
        }),
      );
      return;
    }

    log(`GRANTED ${toolName}  agent=${agentDid}  effectiveScopes=[${effectiveScopes.join(', ')}]`);
    audit.emit({
      event: AuditEvents.AUTHZ_GRANTED,
      correlationId,
      agentDid,
      userDid: typeof vp.delegatedBy === 'string' ? vp.delegatedBy : undefined,
      vcId: grantFromThisSp.id,
      credentialType: 'DelegationGrantCredential',
      issuer: issuer.did,
      toolName,
      requiredScope,
      effectiveScopes,
      result: 'success',
      resultSummary: `Authorized for "${requiredScope}"`,
    });

    const output = runTool(toolName, args, agentDid);
    audit.emit({
      event: AuditEvents.TOOL_INVOKED,
      correlationId,
      agentDid,
      userDid: typeof vp.delegatedBy === 'string' ? vp.delegatedBy : undefined,
      vcId: grantFromThisSp.id,
      toolName,
      requiredScope,
      effectiveScopes,
      result: 'success',
      resultSummary: summarizeToolResult(toolName, output),
    });
    res.json(jsonRpcResult(rpc.id, { structuredContent: output }));
  });

  // ── Consent page ───────────────────────────────────────────────────────
  // Serves the real @helixid/widget controller to the browser (its dist is
  // dependency-free ESM), so the page renders against the shipped state
  // machine rather than a re-implementation of it.

  if (options.widgetDistPath) {
    app.use('/widget', express.static(options.widgetDistPath));
  }

  app.get('/consent', (req: Request, res: Response) => {
    const agentDid = String(req.query['agentDid'] ?? '');
    const userDid = String(req.query['userDid'] ?? '');
    // `demo=1` makes this popup advance itself at presentation pace so an
    // unattended screen recording never stalls here. It changes timing only —
    // the same routes run, and the same grant is signed.
    const demo = req.query['demo'] === '1';
    // Carried through so the grant this page issues lands in the audit trail
    // attached to the tool call that prompted it.
    const correlationId = String(req.query['correlationId'] ?? '');
    if (!browserSession(req)) {
      res.type('html').send(spLoginPageHtml({ definition, agentDid, userDid, demo }));
      return;
    }
    res.type('html').send(
      consentPageHtml({ definition, agentDid, userDid, serviceDid: issuer.did, demo, correlationId }),
    );
  });

  app.post('/api/sp-login', (req: Request, res: Response) => {
    const body = req.body as { username?: string; password?: string; agentDid?: string; userDid?: string };
    if (body.username !== 'ada' || body.password !== 'demo123') {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }
    const token = randomUUID();
    browserSessions.add(token);
    res.setHeader('set-cookie', `sp_session=${token}; HttpOnly; SameSite=Lax; Path=/`);
    res.json({
      authenticated: true,
      redirectUrl: `/consent?agentDid=${encodeURIComponent(body.agentDid ?? '')}&userDid=${encodeURIComponent(body.userDid ?? '')}`,
    });
  });

  return { app, counters, definition, issuerDid: issuer.did };
}

/** Shared chrome for both SP-hosted pages, so login and consent feel like one product. */
function spChrome(definition: SpDefinition): string {
  const accent = definition.id === 'airline' ? '#1f6feb' : '#8250df';
  return `
  :root{--accent:${accent};--bg:#f6f8fa;--surface:#fff;--border:#d8dee4;--text:#1f2328;--muted:#656d76;--dim:#8c959f}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);min-height:100vh;display:grid;place-items:center;padding:24px;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  button{font:inherit;cursor:pointer;border:0}
  .card{width:min(440px,94vw);background:var(--surface);border:1px solid var(--border);
    border-radius:16px;box-shadow:0 12px 40px #1f232814;overflow:hidden}
  .card-head{padding:26px 28px 20px;border-bottom:1px solid var(--border)}
  .brand{width:42px;height:42px;border-radius:12px;background:var(--accent);color:#fff;
    display:grid;place-items:center;font-weight:800;font-size:15px;letter-spacing:.02em}
  h1{font-size:19px;margin-top:16px;letter-spacing:-.01em}
  .lede{color:var(--muted);font-size:13.5px;margin-top:6px;line-height:1.5}
  .card-body{padding:22px 28px 26px}
  .btn{width:100%;padding:11px;border-radius:9px;background:var(--accent);color:#fff;font-weight:650;font-size:14px;
    transition:opacity .15s}
  .btn:hover{opacity:.92}
  .btn:disabled{opacity:.45;cursor:not-allowed}
  .btn-ghost{width:100%;padding:11px;border-radius:9px;background:transparent;color:var(--muted);
    border:1px solid var(--border);font-weight:600;font-size:14px;margin-top:9px}
  .btn-ghost:hover{background:var(--bg);color:var(--text)}
  .foot{padding:14px 28px;background:var(--bg);border-top:1px solid var(--border);
    font-size:11.5px;color:var(--dim);display:flex;align-items:center;gap:7px;line-height:1.5}
  .lock{flex:0 0 auto}
  .error{color:#cf222e;font-size:12.5px;margin-top:12px;min-height:16px}`;
}

function spLoginPageHtml(params: {
  definition: SpDefinition;
  agentDid: string;
  userDid: string;
  demo?: boolean;
}): string {
  const initials = params.definition.id === 'airline' ? 'HA' : 'HS';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Sign in · ${params.definition.displayName}</title>
<style>${spChrome(params.definition)}
  .field{margin-bottom:13px}
  .field label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.07em;
    color:var(--dim);font-weight:650;margin-bottom:6px}
  input{width:100%;padding:11px 12px;border:1px solid var(--border);border-radius:9px;font:inherit;
    outline:none;transition:border-color .15s,box-shadow .15s}
  input:focus{border-color:var(--accent);box-shadow:0 0 0 3px ${params.definition.id === 'airline' ? '#1f6feb22' : '#8250df22'}}
</style>
</head>
<body>
<form class="card" id="login">
  <div class="card-head">
    <div class="brand">${initials}</div>
    <h1>Sign in to ${params.definition.displayName}</h1>
    <p class="lede">You need to be signed in before you can review what this agent is asking to do.</p>
  </div>
  <div class="card-body">
    <div class="field"><label for="username">Username</label><input id="username" value="ada" autocomplete="username" /></div>
    <div class="field"><label for="password">Password</label><input id="password" type="password" value="demo123" autocomplete="current-password" /></div>
    <button class="btn" type="submit">Continue</button>
    <div class="error" id="error"></div>
  </div>
  <div class="foot"><span class="lock">🔒</span><span>${params.definition.displayName} never shares your password with the agent.</span></div>
</form>
<script>
  document.getElementById('login').onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById('error');
    err.textContent = '';
    const res = await fetch('/api/sp-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
        agentDid: ${JSON.stringify(params.agentDid)},
        userDid: ${JSON.stringify(params.userDid)},
      }),
    });
    const body = await res.json();
    if (!res.ok) { err.textContent = body.error || 'Sign in failed'; return; }
    const demo = ${JSON.stringify(Boolean(params.demo))};
    location.href = body.redirectUrl + (demo ? '&demo=1' : '');
  };

  // Unattended demo: sign in on its own, after a beat so the screen is legible.
  if (${JSON.stringify(Boolean(params.demo))}) {
    setTimeout(() => document.getElementById('login').requestSubmit(), 1600);
  }
</script>
</body>
</html>`;
}

// ── C4: the booking backend ──────────────────────────────────────────────

/**
 * One human-readable line describing what a tool actually did — the "Result"
 * column of the activity trail. Reads only from the tool's own output, so it
 * cannot claim something the call did not return.
 */
function summarizeToolResult(toolName: string, output: Record<string, unknown>): string {
  const flights = output['flights'];
  if (Array.isArray(flights)) {
    return `${flights.length} flight${flights.length === 1 ? '' : 's'} found`;
  }
  const hotels = output['hotels'];
  if (Array.isArray(hotels)) {
    return `${hotels.length} hotel${hotels.length === 1 ? '' : 's'} found`;
  }
  const bookingId = output['bookingId'];
  if (typeof bookingId === 'string' && bookingId) {
    const status = typeof output['status'] === 'string' ? output['status'] : 'OK';
    return `${status} — ${bookingId}`;
  }
  return `${toolName} completed`;
}

function runTool(
  toolName: string,
  args: Record<string, unknown>,
  agentDid: string,
): Record<string, unknown> {
  switch (toolName) {
    case 'search_flights': {
      const origin = String(args['origin'] ?? '').toUpperCase();
      const destination = String(args['destination'] ?? '').toUpperCase();
      const departureDate = String(args['departureDate'] ?? '');
      const travelers = Math.max(1, Number(args['travelers'] ?? 1) || 1);
      const carrierPref = String(args['carrier'] ?? '').trim().toLowerCase();

      const route = `${origin}-${destination}`;
      const inventory = FLIGHT_INVENTORY[route] ?? [];
      // No date given means "any date" — still searchable — rather than an
      // empty result; a date that IS given still has to fall in the bookable
      // window.
      const dateAvailable = departureDate === '' || isSearchableDate(departureDate);

      let flights = dateAvailable ? inventory : [];
      // An airline preference narrows the list; "any" or an unknown carrier
      // leaves it untouched so the user is never left with nothing.
      if (carrierPref && carrierPref !== 'any') {
        const narrowed = flights.filter((f) => f.carrier.toLowerCase().includes(carrierPref));
        if (narrowed.length) flights = narrowed;
      }

      return {
        query: { origin, destination, departureDate, travelers, carrier: carrierPref || 'any' },
        flights: flights.map((flight) => ({
          ...flight,
          origin,
          destination,
          departureDate,
          travelers,
          totalFare: flight.fare * travelers,
        })),
      };
    }
    case 'book_flight':
      return {
        bookingId: `FLT-${randomUUID().slice(0, 8).toUpperCase()}`,
        flightId: String(args['flightId'] ?? ''),
        status: 'CONFIRMED',
        bookedBy: agentDid,
      };
    case 'modify_booking':
      return {
        bookingId: String(args['bookingId'] ?? ''),
        status: 'MODIFIED',
        modifiedBy: agentDid,
      };
    case 'search_hotels': {
      const city = String(args['city'] ?? 'DEL').toUpperCase();
      const maxNightlyRate = Number(args['maxNightlyRate'] ?? 0) || 0;
      const guests = Math.max(1, Number(args['guests'] ?? 1) || 1);

      let hotels = HOTEL_INVENTORY[city] ?? [];
      // A budget cap narrows the list, but never to nothing — if everything is
      // above budget, show the cheapest so the conversation can continue.
      if (maxNightlyRate > 0) {
        const affordable = hotels.filter((h) => h.nightlyRate <= maxNightlyRate);
        hotels = affordable.length
          ? affordable
          : [...hotels].sort((a, b) => a.nightlyRate - b.nightlyRate).slice(0, 1);
      }

      return {
        query: { city, maxNightlyRate: maxNightlyRate || null, guests },
        hotels: hotels.map((hotel) => ({ ...hotel, city, guests })),
      };
    }
    case 'book_hotel':
      return {
        bookingId: `HTL-${randomUUID().slice(0, 8).toUpperCase()}`,
        hotelId: String(args['hotelId'] ?? ''),
        status: 'CONFIRMED',
        bookedBy: agentDid,
      };
    default:
      return { ok: true };
  }
}

/**
 * Demo inventory. Two carriers per route so an airline preference is a real
 * filter, and a spread of fares so party size visibly changes the total.
 */
const FLIGHT_INVENTORY: Record<
  string,
  Array<{ flightId: string; carrier: string; departs: string; arrives: string; durationMinutes: number; stops: number; fare: number; cabin: string }>
> = {
  'TVM-DEL': [
    { flightId: 'HA401', carrier: 'Helix Air', departs: '08:20', arrives: '11:05', durationMinutes: 165, stops: 0, fare: 8450, cabin: 'Economy' },
    { flightId: 'HA733', carrier: 'Helix Air', departs: '19:05', arrives: '21:50', durationMinutes: 165, stops: 0, fare: 6980, cabin: 'Economy' },
    { flightId: 'SK512', carrier: 'Skyline', departs: '13:40', arrives: '17:20', durationMinutes: 220, stops: 1, fare: 5600, cabin: 'Economy' },
  ],
  'TVM-BOM': [
    { flightId: 'HA215', carrier: 'Helix Air', departs: '07:10', arrives: '09:15', durationMinutes: 125, stops: 0, fare: 6300, cabin: 'Economy' },
    { flightId: 'SK629', carrier: 'Skyline', departs: '16:45', arrives: '19:10', durationMinutes: 145, stops: 0, fare: 4850, cabin: 'Economy' },
  ],
  'DEL-TVM': [
    { flightId: 'HA402', carrier: 'Helix Air', departs: '14:30', arrives: '17:20', durationMinutes: 170, stops: 0, fare: 8100, cabin: 'Economy' },
    { flightId: 'SK513', carrier: 'Skyline', departs: '06:15', arrives: '10:05', durationMinutes: 230, stops: 1, fare: 5400, cabin: 'Economy' },
  ],
  'BOM-TVM': [
    { flightId: 'HA216', carrier: 'Helix Air', departs: '18:15', arrives: '20:20', durationMinutes: 125, stops: 0, fare: 6150, cabin: 'Economy' },
  ],
};

const HOTEL_INVENTORY: Record<
  string,
  Array<{ hotelId: string; name: string; nightlyRate: number; rating: number; area: string; amenities: string[] }>
> = {
  DEL: [
    { hotelId: 'HS-DEL-1', name: 'Helix Stay Aerocity', nightlyRate: 7400, rating: 4.5, area: 'Aerocity', amenities: ['Airport shuttle', 'Pool', 'Breakfast'] },
    { hotelId: 'HS-DEL-2', name: 'Helix Stay Connaught', nightlyRate: 9100, rating: 4.7, area: 'Connaught Place', amenities: ['City centre', 'Spa', 'Breakfast'] },
    { hotelId: 'HS-DEL-3', name: 'Helix Stay Saket', nightlyRate: 4900, rating: 4.1, area: 'Saket', amenities: ['Metro nearby', 'Workspace'] },
  ],
  BOM: [
    { hotelId: 'HS-BOM-1', name: 'Helix Stay Bandra', nightlyRate: 8200, rating: 4.6, area: 'Bandra West', amenities: ['Sea view', 'Gym'] },
    { hotelId: 'HS-BOM-2', name: 'Helix Stay Andheri', nightlyRate: 5300, rating: 4.2, area: 'Andheri East', amenities: ['Airport shuttle', 'Workspace'] },
  ],
};

function isSearchableDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const requested = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(requested)) return false;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return requested >= todayUtc && requested <= todayUtc + 365 * 24 * 60 * 60 * 1000;
}

function consentPageHtml(params: {
  definition: SpDefinition;
  agentDid: string;
  userDid: string;
  serviceDid: string;
  demo?: boolean;
  correlationId?: string;
}): string {
  const { definition, agentDid, userDid, serviceDid } = params;
  const correlationId = params.correlationId ?? '';
  const initials = definition.id === 'airline' ? 'HA' : 'HS';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize · ${definition.displayName}</title>
<style>${spChrome(definition)}
  .agent{display:flex;align-items:center;gap:11px;padding:13px 14px;background:var(--bg);
    border:1px solid var(--border);border-radius:11px;margin-bottom:20px}
  .agent .ico{width:32px;height:32px;border-radius:9px;background:linear-gradient(135deg,#4f7cff,#7c5cff);
    color:#fff;display:grid;place-items:center;font-weight:800;font-size:12px;flex:0 0 32px}
  .agent .nm{font-size:13.5px;font-weight:640}
  .agent .did{font-size:11px;color:var(--dim);font-family:ui-monospace,Menlo,monospace;
    word-break:break-all;margin-top:2px;line-height:1.4}
  h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);
    font-weight:700;margin-bottom:11px}
  .scope{display:flex;gap:11px;align-items:flex-start;padding:12px 13px;border:1px solid var(--border);
    border-radius:10px;margin-bottom:8px;transition:border-color .15s;cursor:pointer}
  .scope:hover{border-color:var(--accent)}
  .scope.locked{background:var(--bg);cursor:default}
  .scope input{margin-top:2px;width:16px;height:16px;accent-color:var(--accent);flex:0 0 16px;cursor:inherit}
  .scope .t{font-size:13.5px;font-weight:600;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
  .scope .d{font-size:12.5px;color:var(--muted);margin-top:3px;line-height:1.45}
  .req{font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;font-weight:700;
    padding:2px 6px;border-radius:5px;background:var(--border);color:var(--muted)}
  .durs{display:grid;gap:8px;margin-bottom:22px}
  .dur{display:flex;gap:11px;align-items:flex-start;padding:12px 13px;border:1px solid var(--border);
    border-radius:10px;cursor:pointer;transition:border-color .15s}
  .dur:hover{border-color:var(--accent)}
  .dur input{margin-top:2px;accent-color:var(--accent);flex:0 0 auto;cursor:inherit}
  .dur .t{font-size:13.5px;font-weight:600}
  .dur .d{font-size:12.5px;color:var(--muted);margin-top:3px}
  .state{padding:30px 0;text-align:center;color:var(--muted);font-size:13.5px}
  .banner{padding:13px 14px;border-radius:10px;background:#fff5f5;border:1px solid #ffc9c9;
    color:#a4232b;font-size:13px;line-height:1.5;margin-bottom:16px}
  .done{text-align:center;padding:26px 0}
  .done .tick{width:44px;height:44px;border-radius:50%;background:#1a7f37;color:#fff;margin:0 auto 14px;
    display:grid;place-items:center;font-size:21px;font-weight:800}
  .done .t{font-size:16px;font-weight:650}
  .done .d{font-size:13px;color:var(--muted);margin-top:6px}
</style>
</head>
<body>
<div class="card">
  <div class="card-head">
    <div class="brand">${initials}</div>
    <h1>Authorize this agent</h1>
    <p class="lede"><strong>Travel Planner Agent</strong> is asking to act on your behalf at ${definition.displayName}.</p>
  </div>
  <div class="card-body">
    <div class="agent">
      <div class="ico">TP</div>
      <div>
        <div class="nm">Travel Planner Agent</div>
        <div class="did">${agentDid || 'unknown agent'}</div>
      </div>
    </div>
    <div id="root"><div class="state">Loading permissions…</div></div>
  </div>
  <div class="foot">
    <span class="lock">🔒</span>
    <span>Signed by ${definition.displayName} and verified by HelixID. Revocable at any time.</span>
  </div>
</div>

<script type="module">
  // The shipped @helixid/widget controller — this page is only its render layer.
  import { createConsentController } from '/widget/index.js';

  const root = document.getElementById('root');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  function finish(title, detail) {
    root.innerHTML = '<div class="done"><div class="tick">✓</div>' +
      '<div class="t">' + esc(title) + '</div><div class="d">' + esc(detail) + '</div></div>';
  }

  const controller = createConsentController({
    agentDid: ${JSON.stringify(agentDid)},
    agentName: 'Travel Planner Agent',
    userIdentifier: ${JSON.stringify(userDid)},
    serviceDid: ${JSON.stringify(serviceDid)},
    scopesEndpoint: '/api/consent/scopes',
    defaultDurability: 'standing',
    onAccept: async (selection) => {
      const res = await fetch('/api/consent/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          agentDid: ${JSON.stringify(agentDid)},
          userDid: ${JSON.stringify(userDid)},
          scopes: selection.scopes,
          durability: selection.durability,
          correlationId: ${JSON.stringify(correlationId)} || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.grantVC) {
        throw new Error((body.error && body.error.message) || 'Could not issue permission');
      }
      (window.opener || window.parent).postMessage(
        { type: 'helixid:consent-accepted', grantVC: body.grantVC }, '*');
      finish('Permission granted', 'Returning you to the Travel Planner…');
      setTimeout(() => window.close(), 900);
    },
    onDecline: () => {
      (window.opener || window.parent).postMessage({ type: 'helixid:consent-declined' }, '*');
      finish('Nothing was authorized', 'You can close this window.');
      setTimeout(() => window.close(), 900);
    },
  });

  function render(state) {
    if (state.status === 'loading') {
      root.innerHTML = '<div class="state">Loading permissions…</div>';
      return;
    }

    // Fetch failed: Accept is disabled, Decline stays available, no retry.
    if (state.status === 'error') {
      root.innerHTML =
        '<div class="banner">We could not load the permissions this agent is requesting. ' +
        'Nothing has been authorized.<br><small>' + esc(state.error || 'unknown error') + '</small></div>' +
        '<button class="btn" disabled>Allow</button>' +
        '<button class="btn-ghost" id="decline">Close</button>';
      document.getElementById('decline').onclick = () => controller.decline();
      return;
    }

    root.innerHTML =
      '<h2>This agent will be able to</h2>' +
      state.scopeOptions.map((o) => {
        const on = state.selectedScopes.includes(o.scope);
        return '<label class="scope' + (o.required ? ' locked' : '') + '">' +
          '<input type="checkbox" data-scope="' + esc(o.scope) + '"' +
            (on ? ' checked' : '') + (o.required ? ' disabled' : '') + ' />' +
          '<div><div class="t">' + esc(o.label) +
            (o.required ? '<span class="req">Required</span>' : '') + '</div>' +
            (o.description ? '<div class="d">' + esc(o.description) + '</div>' : '') +
          '</div></label>';
      }).join('') +
      '<h2 style="margin-top:22px">For how long</h2>' +
      '<div class="durs">' + state.durabilityOptions.map((d) =>
        '<label class="dur"><input type="radio" name="dur" value="' + esc(d.value) + '"' +
          (state.durability === d.value ? ' checked' : '') + ' />' +
          '<div><div class="t">' + esc(d.label) + '</div>' +
          (d.description ? '<div class="d">' + esc(d.description) + '</div>' : '') +
          '</div></label>').join('') + '</div>' +
      '<button class="btn" id="accept"' + (state.canAccept ? '' : ' disabled') + '>Allow</button>' +
      '<button class="btn-ghost" id="decline">Not now</button>';

    root.querySelectorAll('input[data-scope]').forEach((el) => {
      el.onchange = () => controller.toggleScope(el.dataset.scope);
    });
    root.querySelectorAll('input[name=dur]').forEach((el) => {
      el.onchange = () => controller.setDurability(el.value);
    });
    document.getElementById('accept').onclick = async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Authorizing…';
      try { await controller.accept(); }
      catch (err) {
        root.innerHTML = '<div class="banner">' + esc(err.message) + '</div>' +
          '<button class="btn-ghost" id="decline">Close</button>';
        document.getElementById('decline').onclick = () => controller.decline();
      }
    };
    document.getElementById('decline').onclick = () => controller.decline();
  }

  controller.subscribe(render);
  render(controller.getState());
  await controller.load();

  // Unattended demo: hold long enough for the permissions to be readable on
  // camera, then approve exactly as a click would.
  if (${JSON.stringify(Boolean(params.demo))}) {
    setTimeout(() => {
      const accept = document.getElementById('accept');
      if (accept && !accept.disabled) accept.click();
    }, 3400);
  }
</script>
</body>
</html>`;
}
