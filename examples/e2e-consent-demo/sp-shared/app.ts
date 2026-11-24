// One Service Provider app. Both demo SPs are this same shape: only the tool
// catalog and scope strings differ.
//
//   POST /api/mcp   MCP endpoint (tools/list + tools/call). Open tools run for
//                   anyone; a scoped tool needs the user's consent, verified
//                   from the call itself (see kyaos-gate.ts).
//
// KYA-OS story L3-H: consent is not a grant this SP signs. A call without the
// user's authority gets the signed needs_authorization challenge; its
// authorizationUrl is Helix's consent page, branded as this SP, where the
// user's own did:key signs the root of the agent's chain. The agent retries
// with that hop; this SP verifies it like any other chain. The SP renders no
// consent page and holds no key able to sign as a user.

import express, { type Express, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { SpDefinition } from '../helixid-config/index.js';
import type { AuditEmitter } from './audit.js';
import { challengeToolResult, type Gate } from './kyaos-gate.js';

export interface SpIssuer {
  /** This service's did:web (Helix-hosted, its key kept by the SP). */
  did: string;
}

export interface SpAppOptions {
  definition: SpDefinition;
  issuer: SpIssuer;
  /** The SP's KYA-OS gate: local verification, the signed challenge, response proofs. */
  gate: Gate;
  /** Where this SP reports its own activity events; optional. */
  audit?: AuditEmitter;
}

/** Test-visible counters. */
export interface SpCounters {
  /** Times a tool call was answered with a consent challenge. */
  consentRequired: number;
  /** Times a scoped tool ran on the user's consent. */
  authorized: number;
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
  params?: { name?: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };
}

/** Which of this SP's users the agent acts for: the demo agent names the traveler's account here (see README). */
export const SERVICE_USER_META_KEY = 'org.helixid/service-user';

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

const withoutControlArguments = (args: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(args).filter(([name]) => !name.startsWith('_kyaos') && name !== '_helixCorrelationId'));

export function createSpApp(options: SpAppOptions): SpApp {
  const { definition, issuer, gate } = options;
  const counters: SpCounters = { consentRequired: 0, authorized: 0 };
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const log = (message: string): void => {
    console.log(`[${new Date().toISOString()}] [${definition.id}] ${message}`);
  };
  const audit: AuditEmitter = options.audit ?? { emit: () => undefined };

  // The agent reads `did` from here at startup: Helix minted it at enrollment.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', sp: definition.id, did: issuer.did, tools: definition.tools.map((tool) => tool.name) });
  });

  app.post('/api/mcp', async (req: Request, res: Response) => {
    const rpc = req.body as JsonRpcRequest;

    if (rpc.method === 'tools/list') {
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

    const params = rpc.params ?? {};
    const toolName = params.name ?? '';
    const args = params.arguments ?? {};
    const tool = definition.tools.find((entry) => entry.name === toolName);
    if (!tool) {
      res.json(jsonRpcError(rpc.id, -32602, `Unknown tool: ${toolName}`));
      return;
    }
    const requiredScope = tool.metadata?.requiredScope;
    const correlationId = typeof args['_helixCorrelationId'] === 'string' ? args['_helixCorrelationId'] : undefined;
    const request = { method: 'tools/call', params: params as Record<string, unknown> };

    // Open, read-only tools run with no proof and no scope check.
    if (!requiredScope) {
      log(`OPEN    ${toolName}`);
      const output = runTool(toolName, withoutControlArguments(args), 'anonymous');
      audit.emit({ event: 'tool.call.completed', correlationId, toolName, result: 'success', resultSummary: summarizeToolResult(toolName, output), reason: 'OPEN_TOOL_NO_SCOPE_REQUIRED' });
      res.json(jsonRpcResult(rpc.id, { structuredContent: output }));
      return;
    }

    // The agent's own request proof, and the chain the user signed when there is one: verified here, from the call alone.
    const verdict = await gate.verify(request);
    if (!verdict.ok) {
      log(`DENIED  ${toolName}  ${verdict.code}`);
      audit.emit({ event: 'proof.rejected', correlationId, toolName, requiredScope, result: 'failure', reason: verdict.code, resultSummary: `Verification failed (${verdict.code})` });
      res.json(jsonRpcResult(rpc.id, await gate.sign(request, { isError: true, content: [{ type: 'text', text: verdict.message }], structuredContent: { error: verdict.code } }, 'denied')));
      return;
    }

    let scopes = verdict.scopes;
    // L3-E: a retry after consent carries the resume token and the new hop; the hop is verified in full before it grants anything.
    const retry = gate.needsAuthorization.readRetry({ input: args });
    if (retry !== undefined) {
      try {
        const granted = await gate.needsAuthorization.authorizeRetry(retry.resumeToken, retry.credential, { agentDid: verdict.agentDid, tool: toolName, scopes: [requiredScope] });
        scopes = [...new Set([...scopes, ...granted.scopes])];
      } catch (error) {
        const reason = (error as { reason?: string }).reason ?? 'resume_refused';
        log(`DENIED  ${toolName}  retry refused (${reason})`);
        res.json(jsonRpcResult(rpc.id, await gate.sign(request, { isError: true, content: [{ type: 'text', text: (error as Error).message }], structuredContent: { error: reason } }, 'denied', verdict.agentDid)));
        return;
      }
    }

    if (!scopes.includes(requiredScope)) {
      counters.consentRequired += 1;
      const serviceUserId = typeof params._meta?.[SERVICE_USER_META_KEY] === 'string' ? (params._meta[SERVICE_USER_META_KEY] as string) : undefined;
      if (serviceUserId === undefined) {
        res.json(jsonRpcError(rpc.id, -32602, `Consent for ${requiredScope} needs to know which of this service's users the agent acts for`, { code: 'SERVICE_USER_REQUIRED' }));
        return;
      }
      log(`CONSENT ${toolName}  agent ${verdict.agentDid} lacks ${requiredScope}; challenge for ${serviceUserId}`);
      audit.emit({
        event: 'authorization.denied',
        correlationId,
        agentDid: verdict.agentDid,
        toolName,
        requiredScope,
        effectiveScopes: scopes,
        result: 'blocked',
        reason: 'NEEDS_AUTHORIZATION',
        resultSummary: `${toolName} needs consent: the user has not yet authorized ${definition.displayName}`,
      });
      let challenge;
      try {
        challenge = await gate.challenge({ agentDid: verdict.agentDid, tool: toolName, scope: requiredScope, serviceUserId });
      } catch (error) {
        // Helix refused the consent request (an agent not attested for the scope, say): no URL to send.
        log(`DENIED  ${toolName}  consent request refused: ${(error as Error).message}`);
        res.json(jsonRpcError(rpc.id, -32603, `Could not ask for consent: ${(error as Error).message}`, { code: 'CONSENT_REQUEST_FAILED' }));
        return;
      }
      res.json(jsonRpcResult(rpc.id, await gate.sign(request, challengeToolResult(challenge), 'needs_authorization', verdict.agentDid)));
      return;
    }

    counters.authorized += 1;
    log(`GRANTED ${toolName}  agent=${verdict.agentDid}  user=${verdict.userDid ?? '-'}  scopes=[${scopes.join(', ')}]  level=${verdict.level}`);
    audit.emit({
      event: 'authorization.approved',
      correlationId,
      agentDid: verdict.agentDid,
      ...(verdict.userDid === undefined ? {} : { userDid: verdict.userDid }),
      toolName,
      requiredScope,
      effectiveScopes: scopes,
      result: 'success',
      resultSummary: `Authorized for "${requiredScope}" on the user's consent`,
    });
    const output = runTool(toolName, withoutControlArguments(args), verdict.agentDid, verdict.userDid);
    audit.emit({ event: 'tool.call.completed', correlationId, agentDid: verdict.agentDid, toolName, requiredScope, effectiveScopes: scopes, result: 'success', resultSummary: summarizeToolResult(toolName, output) });
    res.json(jsonRpcResult(rpc.id, await gate.sign(request, { structuredContent: output }, 'allowed', verdict.agentDid)));
  });

  return { app, counters, definition, issuerDid: issuer.did };
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
  /** The user's did:key that signed the root hop: whom the booking is for. */
  userDid?: string,
): Record<string, unknown> {
  const onBehalfOf = userDid === undefined ? {} : { onBehalfOf: userDid };
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
        ...onBehalfOf,
      };
    case 'modify_booking':
      return {
        bookingId: String(args['bookingId'] ?? ''),
        status: 'MODIFIED',
        modifiedBy: agentDid,
        ...onBehalfOf,
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
        ...onBehalfOf,
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

