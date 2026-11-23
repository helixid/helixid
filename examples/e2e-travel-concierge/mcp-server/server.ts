// mcp-server — a Model Context Protocol server exposing two protected tools:
// search_flights (needs read:catalog) and book_flight (needs write:orders).
//
// The only thing standing between an inbound tool call and the action is the
// service's KYA-OS check (stories C-C, F-2), done here, in-process, with
// @helixid/mcp-middleware's local verifier:
//   1. the agent's request proof: signed by the key its DID document lists,
//      for this service (audience), fresh, each nonce once;
//   2. its Entity Card: the capabilities its credentials attest, and its
//      revocation entry, read live from HelixID's status list;
//   3. the delegation chain it carries: every hop's signature and status
//      (live), rooted in the agent's responsible party, narrowing at each link;
//   4. the tool's scope among the effective scopes (attestations ∩ chain ∩
//      this service's catalog).
// No proof, a bad one, a revoked agent or hop, or the wrong scope, and the tool
// never runs. No call to HelixID per request beyond the public documents and
// status lists it publishes. Every answer carries this service's response
// proof, signed with its own key.
//
// tools/call is answered by that check before the MCP SDK sees it; initialize
// and tools/list go to the SDK.
import 'dotenv/config';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { z, type ZodRawShape } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { attachResponseProof, buildResponseProof, createLocalVerifier } from '@helixid/mcp-middleware';
import { EnvSigner, kyaos } from '@helixid/sdk-js';
import { SCOPES, TOOLS, env } from '../config.js';
import { helixFetch } from '../helixid.js';
import { loadService } from '../service/identity.js';

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [MCP] ${message}`);
}

type CallResult = {
  isError?: boolean;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
};

/** Every refusal carries a machine-readable code so the agent (and the demo) can tell them apart. */
function deny(tool: string, code: string, reason: string): CallResult {
  log(`DENIED  ${tool}  ${code}  ${reason}`);
  return { isError: true, content: [{ type: 'text', text: `Refused by HelixID [${code}]: ${reason}.` }], structuredContent: { refused: true, code, reason } };
}

interface GuardedTool {
  name: string;
  requiredScope: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  run: (args: Record<string, unknown>, agentDid: string) => { text: string; structured: Record<string, unknown> };
}

const GUARDED_TOOLS: GuardedTool[] = [
  {
    name: TOOLS.SEARCH,
    requiredScope: SCOPES.FLIGHTS_READ,
    title: 'Search flights',
    description: 'Search available flights. Requires read:catalog.',
    inputSchema: {
      origin: z.string().describe('Origin city or airport code'),
      destination: z.string().describe('Destination city or airport code'),
      date: z.string().optional().describe('Optional travel date, YYYY-MM-DD'),
    },
    run: (args, agentDid) => {
      const origin = String(args.origin ?? '');
      const destination = String(args.destination ?? '');
      const flights = [
        { flightId: 'BA249', carrier: 'British Airways', origin, destination, departs: '18:40' },
        { flightId: 'AI302', carrier: 'Air India', origin, destination, departs: '09:15' },
      ];
      return {
        text: JSON.stringify({ flights, searchedBy: agentDid }),
        structured: { flights, searchedBy: agentDid },
      };
    },
  },

  {
    name: TOOLS.BOOK,
    requiredScope: SCOPES.FLIGHTS_BOOK,
    title: 'Book a flight',
    description: 'Book a specific flight for a passenger. Requires write:orders.',
    inputSchema: {
      flightId: z.string().describe('The flight identifier to book, e.g. BA249'),
      passengerName: z.string().describe('Full name of the passenger'),
    },
    run: (args, agentDid) => {
      const booking = {
        bookingId: `BKG-${randomUUID().slice(0, 8).toUpperCase()}`,
        flightId: String(args.flightId ?? ''),
        passengerName: String(args.passengerName ?? ''),
        status: 'CONFIRMED',
        verifiedAgent: agentDid,
      };
      return { text: JSON.stringify(booking), structured: booking };
    },
  },

];

function buildServer(): McpServer {
  const server = new McpServer({ name: 'travel-booking-mcp', version: '0.3.0' });
  for (const tool of GUARDED_TOOLS) {
    // tools/call never reaches this handler: the KYA-OS check answers it (handleToolCall).
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.inputSchema }, async () => ({
      isError: true,
      content: [{ type: 'text' as const, text: 'tools/call is answered by the KYA-OS check' }],
    }));
  }
  return server;
}

/** HelixID's own status list, bound so a card's revocation entry is read (SPEC-ENTITY-CARD §10.3). */
async function helixStatusListBinding(): Promise<Record<string, string[]> | undefined> {
  const health = (await (await fetch(`${env.helixApiUrl}/health`)).json().catch(() => ({}))) as { issuerDid?: string };
  return health.issuerDid ? { [health.issuerDid]: [`${env.helixApiUrl}/v1/status-list/helix-status-list-1`] } : undefined;
}

const service = await loadService();
const signer = new EnvSigner({ did: service.did, envVar: 'SERVICE_KEY', env: { SERVICE_KEY: service.signingKey } });
const statusListIssuers = await helixStatusListBinding();
const verifier = createLocalVerifier({
  serviceDid: service.did,
  catalog: [SCOPES.FLIGHTS_READ, SCOPES.FLIGHTS_BOOK],
  fetch: helixFetch,
  allowLoopbackHttp: true,
  ...(statusListIssuers ? { statusListIssuers } : {}),
  log: () => undefined,
});

type CoveredRequest = { method: string; params: Record<string, unknown> };

async function sign(request: CoveredRequest, result: CallResult, outcome: 'allowed' | 'denied', clientDid?: string): Promise<Record<string, unknown>> {
  const proof = await buildResponseProof(
    {
      did: service.did,
      kid: `${service.did}#key-1`,
      ts: Math.floor(Date.now() / 1000),
      nonce: kyaos.generateNonce(),
      audience: service.did,
      sessionId: 'none',
      requestHash: kyaos.hashRequest(request),
      ...(outcome === 'denied' ? {} : { responseHash: kyaos.hashResponse(result, kyaos.RESPONSE_PROOF_ENVELOPE_PROFILE), prf: kyaos.RESPONSE_PROOF_ENVELOPE_PROFILE }),
      outcome,
      ...(clientDid === undefined ? {} : { clientDid }),
    } as kyaos.ProofMeta,
    signer,
  );
  return attachResponseProof(result as Record<string, unknown>, proof);
}

async function handleToolCall(request: CoveredRequest): Promise<Record<string, unknown>> {
  const name = String(request.params['name'] ?? '');
  const tool = GUARDED_TOOLS.find((entry) => entry.name === name);
  if (!tool) return sign(request, deny(name, 'UNKNOWN_TOOL', `no tool ${name}`), 'denied');
  const args = (request.params['arguments'] ?? {}) as Record<string, unknown>;
  const verdict = await verifier.verifyCall({ name, input: args, _meta: request.params['_meta'] as Record<string, unknown>, request, liveStatus: true });
  if (verdict === undefined) return sign(request, deny(name, 'PROOF_MISSING', 'no request proof was supplied'), 'denied');
  if (!verdict.ok || verdict.agentDid === undefined) {
    return sign(request, deny(name, (verdict.reasons[0] ?? 'refused').toUpperCase(), verdict.messages.join('; ') || 'the call did not verify'), 'denied');
  }
  if (!verdict.effectiveScopes.includes(tool.requiredScope)) {
    return sign(
      request,
      deny(name, 'INSUFFICIENT_SCOPE', `agent ${verdict.agentDid} is verified but lacks ${tool.requiredScope}; its effective scopes are [${verdict.effectiveScopes.join(', ') || 'none'}]`),
      'denied',
      verdict.agentDid,
    );
  }
  log(`GRANTED ${name}  agent=${verdict.agentDid}  scopes=[${verdict.effectiveScopes.join(', ')}]  level=${verdict.level}`);
  const out = tool.run(args, verdict.agentDid);
  return sign(request, { content: [{ type: 'text', text: out.text }], structuredContent: out.structured }, 'allowed', verdict.agentDid);
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', did: service.did, tools: [TOOLS.SEARCH, TOOLS.BOOK] }));

// Stateless Streamable HTTP: one server + transport per POST, closed on response.
app.post('/mcp', async (req, res) => {
  const rpc = req.body as { id?: unknown; method?: string; params?: Record<string, unknown> };
  if (rpc?.method === 'tools/call') {
    try {
      return void res.json({ jsonrpc: '2.0', id: rpc.id ?? null, result: await handleToolCall({ method: 'tools/call', params: rpc.params ?? {} }) });
    } catch (err) {
      log(`check error: ${err instanceof Error ? err.message : String(err)}`);
      return void res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: rpc.id ?? null });
    }
  }
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log(`transport error: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  }
});

// Stateless mode does not use GET/DELETE session streams.
const methodNotAllowed = (_req: express.Request, res: express.Response): express.Response =>
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

app.listen(env.mcpPort, '0.0.0.0', () => {
  log(`travel-booking MCP server listening on :${env.mcpPort}/mcp`);
  log(`Service ${service.did}: guarding ${TOOLS.SEARCH} (needs ${SCOPES.FLIGHTS_READ}) and ${TOOLS.BOOK} (needs ${SCOPES.FLIGHTS_BOOK}) with the KYA-OS local verifier.`);
});
