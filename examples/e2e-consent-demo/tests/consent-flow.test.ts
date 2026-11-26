// The 5-step consent demo flow on KYA-OS (story L3-H), end to end against a
// real helix-api and both SP servers: the consent page is Helix's, the root
// hop of the agent's chain is signed by the user's own pairwise did:key, and
// the second booking at the same SP carries that hop without asking again.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConsentFlowError, kyaos } from '@helixid/sdk-js';
import { callSpTool, completeConsent, type ConsentPrompt } from '../agent/consentAwareCall.js';
import { startHarness, type Harness } from './harness.js';

let h: Harness;

beforeAll(async () => {
  h = await startHarness(47101, 47102);
}, 120_000);

afterAll(async () => {
  await h?.stop();
});

async function askConsent(sp: Harness['airline'], tool: string, args: Record<string, unknown>): Promise<ConsentPrompt> {
  const first = await callSpTool(h.callOptions(sp, tool, args));
  if (first.status !== 'consent_required') throw new Error(`expected a consent challenge, got ${JSON.stringify(first)}`);
  return first.prompt;
}

describe('the 5-step flow', () => {
  it('step 2: search is open — no proof checked, no consent asked', async () => {
    const result = await callSpTool(h.callOptions(h.airline, 'search_flights', { origin: 'TVM', destination: 'DEL', departureDate: '2026-12-10' }));
    expect(result.status).toBe('ok');
    expect(h.airline.spApp.counters.consentRequired).toBe(0);
  });

  let airlineUser: string;
  it("step 3: the first Airline booking gets the SP's signed challenge to Helix's consent page; the user approves; the booking runs on her did:key", async () => {
    const prompt = await askConsent(h.airline, 'book_flight', { flightId: 'HA101' });
    expect(new URL(prompt.authorizationUrl).origin).toBe(new URL(h.helixApiUrl).origin);
    expect(prompt.authorizationUrl).toMatch(/\/consent\/[A-Za-z0-9_-]+$/);
    expect(prompt.scopes).toEqual(['book:flights']);
    expect(h.airline.spApp.counters.consentRequired).toBe(1);

    await h.decide(prompt.authorizationUrl, 'approve');
    const booked = await completeConsent(h.callOptions(h.airline, 'book_flight', { flightId: 'HA101' }), prompt);
    expect(booked.status, JSON.stringify(booked)).toBe('ok');
    const data = (booked as { data: Record<string, string> }).data;
    expect(data['bookedBy']).toBe(h.agentDid);
    expect(data['onBehalfOf']).toMatch(/^did:key:z6Mk/);
    airlineUser = data['onBehalfOf']!;
    const stored = await h.consents.get(h.airline.serviceDid);
    expect(stored?.hop['issuer']).toBe(airlineUser);
    expect((stored?.hop['credentialSubject'] as { allowedAction: string[] }).allowedAction).toEqual(['book:flights']);
  });

  it('step 4: the Hotel SP is independent — its own challenge, its own consent, a different did:key', async () => {
    const prompt = await askConsent(h.hotel, 'book_hotel', { hotelId: 'HS-DEL-1' });
    await h.decide(prompt.authorizationUrl, 'approve');
    const booked = await completeConsent(h.callOptions(h.hotel, 'book_hotel', { hotelId: 'HS-DEL-1' }), prompt);
    expect(booked.status, JSON.stringify(booked)).toBe('ok');
    const hotelUser = (booked as { data: Record<string, string> }).data['onBehalfOf'];
    expect(hotelUser).toMatch(/^did:key:/);
    expect(hotelUser).not.toBe(airlineUser);
    // The Airline's consent is untouched.
    expect((await h.consents.get(h.airline.serviceDid))?.hop['issuer']).toBe(airlineUser);
  });

  it('step 5: the second Airline booking carries the stored hop — no challenge, no new consent', async () => {
    const challengesBefore = h.airline.spApp.counters.consentRequired;
    const hopBefore = (await h.consents.get(h.airline.serviceDid))?.hop['id'];
    const result = await callSpTool(h.callOptions(h.airline, 'book_flight', { flightId: 'HA202' }));
    expect(result.status, JSON.stringify(result)).toBe('ok');
    expect((result as { consentReused: boolean }).consentReused).toBe(true);
    expect(h.airline.spApp.counters.consentRequired).toBe(challengesBefore);
    expect((await h.consents.get(h.airline.serviceDid))?.hop['id']).toBe(hopBefore);
  });
});

describe('consent is refused and isolated', () => {
  it('declining on the consent page: the agent is told so and books nothing', async () => {
    await h.consents.drop(h.hotel.serviceDid);
    const prompt = await askConsent(h.hotel, 'book_hotel', { hotelId: 'HS-DEL-2' });
    await h.decide(prompt.authorizationUrl, 'deny');
    const failure = await completeConsent(h.callOptions(h.hotel, 'book_hotel', { hotelId: 'HS-DEL-2' }), prompt).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConsentFlowError);
    expect((failure as ConsentFlowError).reason).toBe(kyaos.consent.ConsentReasons.NOT_APPROVED);
    expect(await h.consents.get(h.hotel.serviceDid)).toBeUndefined();
  });

  it("the Airline's hop is no authority at the Hotel: the Hotel challenges instead of booking", async () => {
    const airlineHop = (await h.consents.get(h.airline.serviceDid))!.hop;
    const call = await kyaos.withRequestProof(
      { method: 'tools/call', params: { name: 'book_hotel', arguments: { hotelId: 'HS-DEL-3' }, _meta: { 'org.helixid/service-user': 'ada' } } },
      h.signer,
      { audience: h.hotel.serviceDid, chain: [airlineHop] },
    );
    const res = await fetch(h.hotel.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...call }) });
    const body = (await res.json()) as { result?: Record<string, unknown> };
    expect(kyaos.isNeedsAuthorization(body.result) || body.result?.['isError'] === true, JSON.stringify(body)).toBe(true);
  });

  it('a call signed for the Airline is refused by the Hotel (the proof names its audience)', async () => {
    const call = await kyaos.withRequestProof({ method: 'tools/call', params: { name: 'book_hotel', arguments: { hotelId: 'HS-DEL-3' } } }, h.signer, { audience: h.airline.serviceDid });
    const res = await fetch(h.hotel.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...call }) });
    const body = (await res.json()) as { result?: { isError?: boolean; structuredContent?: { error?: string } } };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent?.error).toMatch(/audience/);
  });

  it('each SP lists only its own tools, and the two SPs have distinct DIDs', async () => {
    const list = async (url: string): Promise<string[]> =>
      (((await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json()) as { result: { tools: { name: string }[] } }).result.tools).map((t) => t.name);
    expect(await list(h.airline.mcpUrl)).toEqual(expect.arrayContaining(['search_flights', 'book_flight']));
    expect(await list(h.airline.mcpUrl)).not.toContain('book_hotel');
    expect(await list(h.hotel.mcpUrl)).not.toContain('book_flight');
    expect(h.airline.serviceDid).not.toBe(h.hotel.serviceDid);
  });
});

describe('SP activity log', () => {
  it('records an open tool, the consent challenge, and the authorized booking with the user it ran for', () => {
    const events = h.airline.audit.map((e) => `${String(e['event'])}:${String(e['toolName'])}:${String(e['result'])}`);
    expect(events).toContain('tool.call.completed:search_flights:success');
    expect(events).toContain('authorization.denied:book_flight:blocked');
    expect(events).toContain('authorization.approved:book_flight:success');
    const approved = h.airline.audit.find((e) => e['event'] === 'authorization.approved');
    expect(approved?.['agentDid']).toBe(h.agentDid);
    expect(String(approved?.['userDid'])).toMatch(/^did:key:/);
  });
});
