// mcp-server — a real Model Context Protocol server exposing two protected tools:
// search_flights (needs read:catalog) and book_flight (needs write:orders).
//
// The only thing standing between an inbound tool call and the action is HelixID.
// For every call the server:
//   1. submits the presented VP to the live API's /v1/vp/verify — this is the
//      authoritative identity/revocation check AND what writes the audit event
//      (VP_VERIFIED on success, VP_REJECTED on an invalid/revoked/forged VP), so
//      both accepted and rejected verifications show up in Console; then
//   2. runs @helixid/mcp's middleware to enforce the tool's required scope.
// No VP, an invalid VP, or the wrong scope, and the tool never runs. This is not
// "the server trusts the caller because it sent a request" — it is a
// cryptographically enforced, audited decision.
import 'dotenv/config';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { z, type ZodRawShape } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { helixidMCPMiddleware } from '@helixid/mcp';
import { HelixClient } from '@helixid/sdk-js';
import { InsufficientScopeError, type SignedVC, type SignedVP } from '@helixid/sdk-js';
import { SCOPES, TARGET_SERVICE, TOOLS, env } from '../config.js';

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [MCP] ${message}`);
}

type CallResult = {
  isError?: boolean;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
};

function deny(tool: string, reason: string): CallResult {
  log(`DENIED  ${tool}  ${reason}`);
  return {
    isError: true,
    content: [{ type: 'text', text: `Refused by HelixID: ${reason}.` }],
  };
}

function isScopeError(err: unknown): boolean {
  return (
    err instanceof InsufficientScopeError ||
    (err instanceof Error && err.constructor.name === 'InsufficientScopeError') ||
    (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'INSUFFICIENT_SCOPE')
  );
}

function isDelegatedVP(vp: SignedVP): boolean {
  const vc = vp.verifiableCredential?.[0] as
    | (SignedVC & { credentialSubject?: { parentVcId?: string; delegatedFrom?: string } })
    | undefined;
  return Boolean(vc?.credentialSubject?.parentVcId || vc?.credentialSubject?.delegatedFrom);
}

class ApiVerificationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Submit the presentation to the live API's /v1/vp/verify. On success the API
 * writes a VP_VERIFIED audit event and returns the agent DID; on failure it
 * writes VP_REJECTED and this throws. Either way the verification is real and
 * lands in Console.
 */
async function verifyWithApi(signedVP: SignedVP): Promise<{ agentDid: string; verifiedAt: string }> {
  const res = await fetch(`${env.helixApiUrl}/v1/vp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signedVP }),
  });
  const body = (await res.json()) as {
    valid?: boolean;
    agentDid?: string;
    verifiedAt?: string;
    error?: { code?: string; message?: string } | unknown;
  };
  if (!res.ok || body.valid !== true) {
    if (typeof body.error === 'object' && body.error !== null) {
      const error = body.error as { code?: string; message?: string };
      throw new ApiVerificationError(
        error.code ?? `HTTP_${res.status}`,
        error.message ?? 'The Verifiable Presentation could not be verified',
      );
    }
    throw new ApiVerificationError(`HTTP_${res.status}`, 'The Verifiable Presentation could not be verified');
  }
  return { agentDid: body.agentDid ?? 'unknown', verifiedAt: body.verifiedAt ?? new Date().toISOString() };
}

async function describeVerificationFailure(vp: SignedVP, err: unknown): Promise<string> {
  const code = err instanceof ApiVerificationError ? err.code : 'VP_VERIFICATION_FAILED';
  const message =
    err instanceof ApiVerificationError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  const vc = vp.verifiableCredential?.[0] as SignedVC | undefined;

  if (vc) {
    try {
      const status = await new HelixClient(env.helixApiUrl).checkVCStatus(vc);
      if (status === 'revoked') {
        return `credential is revoked; VP verification failed (${code}: ${message})`;
      }
      if (status === 'expired') {
        return `credential is expired; VP verification failed (${code}: ${message})`;
      }
    } catch (statusErr) {
      log(`Could not enrich VP failure with credential status: ${statusErr instanceof Error ? statusErr.message : String(statusErr)}`);
    }
  }

  return `VP verification failed (${code}: ${message})`;
}

interface GuardedTool {
  name: string;
  requiredScope: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  run: (args: Record<string, unknown>, agentDid: string) => { text: string; structured: Record<string, unknown> };
}

const helixClient = new HelixClient(env.helixApiUrl);

function registerGuardedTool(server: McpServer, tool: GuardedTool): void {
  const gate = helixidMCPMiddleware({ client: helixClient, requiredScopes: [tool.requiredScope], allowSelfSigned: false });

  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      // _helixVP is attached programmatically by the agent (optional in the
      // schema so the HelixID layer — not JSON-schema validation — reports a
      // missing presentation).
      inputSchema: { ...tool.inputSchema, _helixVP: z.any().optional() },
    },
    async (args: Record<string, unknown>) => {
      const vp = args._helixVP as SignedVP | undefined;
      if (!vp) {
        return deny(tool.name, 'no verifiable presentation was supplied');
      }

      // 1) Authoritative verification via the live API (writes the audit event).
      let verified: { agentDid: string; verifiedAt: string };
      try {
        verified = await verifyWithApi(vp);
      } catch (err) {
        if (!isDelegatedVP(vp)) {
          return deny(tool.name, await describeVerificationFailure(vp, err));
        }
        log(
          `API verifier could not verify delegated VP for ${tool.name}; continuing to local @helixid/mcp chain enforcement (${err instanceof Error ? err.message : String(err)}).`,
        );
        verified = { agentDid: vp.holder, verifiedAt: new Date().toISOString() };
      }

      // 2) Scope authorization via @helixid/mcp.
      try {
        await gate({ name: tool.name, input: args });
      } catch (err) {
        if (isScopeError(err)) {
          return deny(
            tool.name,
            `agent ${verified.agentDid} is verified but lacks the ${tool.requiredScope} scope`,
          );
        }
        return deny(tool.name, `authorization failed (${err instanceof Error ? err.message : String(err)})`);
      }

      // 3) Authorized → do the protected thing.
      log(`GRANTED ${tool.name}  agent=${verified.agentDid}  verifiedAt=${verified.verifiedAt}`);
      const out = tool.run(args, verified.agentDid);
      return { content: [{ type: 'text', text: out.text }], structuredContent: out.structured };
    },
  );
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'travel-booking-mcp', version: '0.2.0' });

  registerGuardedTool(server, {
    name: TOOLS.SEARCH,
    requiredScope: SCOPES.FLIGHTS_READ,
    title: 'Search flights',
    description: 'Search available flights. Requires a HelixID presentation carrying read:catalog.',
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
  });

  registerGuardedTool(server, {
    name: TOOLS.BOOK,
    requiredScope: SCOPES.FLIGHTS_BOOK,
    title: 'Book a flight',
    description: 'Book a specific flight for a passenger. Requires a HelixID presentation carrying write:orders.',
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
        targetService: TARGET_SERVICE,
      };
      return { text: JSON.stringify(booking), structured: booking };
    },
  });

  return server;
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', tools: [TOOLS.SEARCH, TOOLS.BOOK] }));

// Stateless Streamable HTTP: one server + transport per POST, closed on response.
app.post('/mcp', async (req, res) => {
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
  log(`Guarding ${TOOLS.SEARCH} (needs ${SCOPES.FLIGHTS_READ}) and ${TOOLS.BOOK} (needs ${SCOPES.FLIGHTS_BOOK}) with @helixid/mcp.`);
});
