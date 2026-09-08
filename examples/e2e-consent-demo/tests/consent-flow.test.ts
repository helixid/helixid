// Epic 5 Part H — the demo's 5-step flow, driven end to end against two real
// SP servers over real HTTP.
//
// No LLM is involved: the agent's tool-calling logic is exercised directly, so
// the flow is deterministic and runs in CI. Everything below the agent is the
// real thing — real did:web resolution over HTTP, real grant issuance signed
// with each SP's own key, real helix-core verifyVP, real status-list fetches.
//
// Part D's step 5 is the non-negotiable assertion: booking a second flight with
// the SAME Airline SP must reuse the standing grant, issuing zero new grants
// and rendering the consent widget zero times.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearDIDCache,
  createEd25519Proof,
  generateKeyPair,
  publicKeyToMultibase,
  type SignedVC,
} from '@helixid/sdk-js';
import { HelixClient } from '@helixid/sdk-js';
import {
  AGENT_PRIVILEGE_SCOPES,
  DEMO_USER_DID,
  SCOPES,
  type SpDefinition,
} from '../helixid-config/index.js';
import { createSpApp, type SpApp } from '../sp-shared/app.js';
import { provisionSpIdentity, statePath } from '../sp-shared/identity.js';
import { SpStore } from '../sp-shared/store.js';
import { callSpTool, type ConsentPrompt } from '../agent/consentAwareCall.js';
import { onboardLiveAgent, startLiveApi, type LiveApi } from '../../../tests/utils/liveApi.js';
import { heldGrant, heldGrants } from './harness.js';

const AIRLINE_PORT = 14101;
const HOTEL_PORT = 14102;
const HOST = 'localhost';

interface RunningSp {
  spApp: SpApp;
  server: Server;
  baseUrl: string;
  mcpUrl: string;
  serviceDid: string;
  stateFile: string;
}

let workDir: string;
let api: LiveApi;
let airline: RunningSp;
let hotel: RunningSp;
let client: HelixClient;
let agentDid: string;

async function startSp(definition: SpDefinition, port: number): Promise<RunningSp> {
  const { identity, statusList } = await provisionSpIdentity({
    dir: workDir,
    spId: definition.id,
    host: HOST,
    port,
  });
  const stateFile = statePath(workDir, definition.id);
  const store = await SpStore.open(stateFile, statusList);

  const baseUrl = `http://${HOST}:${port}`;
  const spApp = createSpApp({
    definition: { ...definition, port },
    issuer: {
      did: identity.did,
      privateKeyHex: identity.privateKeyHex,
      publicKeyHex: identity.publicKeyHex,
    },
    baseUrl,
    helixApiUrl: api.baseUrl,
    store,
  });

  const server = await new Promise<Server>((resolve) => {
    const listening = spApp.app.listen(port, HOST, () => resolve(listening));
  });

  return { spApp, server, baseUrl, mcpUrl: `${baseUrl}/api/mcp`, serviceDid: identity.did, stateFile };
}

/**
 * Stands in for the End User at the SP's consent page. Deliberately drives the
 * same two routes the widget drives — GET the catalog, POST the selection — so
 * the SP's scopeResolutions counter is a faithful count of widget renders.
 */
function acceptAllConsent(sp: RunningSp) {
  return async (prompt: ConsentPrompt): Promise<SignedVC> => {
    const catalogRes = await fetch(
      `${sp.baseUrl}/api/consent/scopes?agentDid=${encodeURIComponent(agentDid)}`,
    );
    const { scopeOptions } = (await catalogRes.json()) as {
      scopeOptions: Array<{ scope: string }>;
    };

    const acceptRes = await fetch(`${sp.baseUrl}/api/consent/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentDid,
        userDid: DEMO_USER_DID,
        scopes: scopeOptions.map((option) => option.scope),
        durability: 'standing',
      }),
    });
    const body = (await acceptRes.json()) as { grantVC: SignedVC };
    expect(prompt.serviceDid).toBe(sp.serviceDid);
    return body.grantVC;
  };
}

/** Consent handler that must never run. Used to prove step 5 does not prompt. */
const refuseToPrompt = async (prompt: ConsentPrompt): Promise<SignedVC> => {
  throw new Error(
    `Consent was requested when it should not have been (service=${prompt.serviceDid}, scope=${prompt.requiredScope})`,
  );
};

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'helix-consent-demo-'));
  clearDIDCache();
  // issueGrant() and verifyVP() are API-mediated (docs/proposal-sdk-api-only.md),
  // so both SPs need a real helix-api to call — a fresh, fully-local (SQLite,
  // did:key) instance per run, same as the root workspace's own live suite.
  api = await startLiveApi();

  const { AIRLINE, HOTEL } = await import('../helixid-config/index.js');
  airline = await startSp(AIRLINE, AIRLINE_PORT);
  hotel = await startSp(HOTEL, HOTEL_PORT);

  // The platform issues the agent's authority credential as part of
  // onboarding. Its scopes are the ceiling; a consent grant narrows within
  // it, never past it. Under server custody the agent has no key of its own,
  // so the API must know this agent in order to sign for it.
  client = new HelixClient(api.baseUrl, { adminApiKey: api.adminApiKey });
  const agent = await onboardLiveAgent(api, client, {
    agentName: 'Travel Planner Agent',
    requestedScopes: [...AGENT_PRIVILEGE_SCOPES],
    requestedDomains: ['https://travel-planner.agent.example.com'],
  });
  agentDid = agent.did;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => airline.server.close(() => resolve()));
  await new Promise<void>((resolve) => hotel.server.close(() => resolve()));
  await rm(workDir, { recursive: true, force: true });
  await api.stop();
});

describe('Epic 5 — 5-step consent demo flow (Part D / Part H)', () => {
  it('step 1: the End User identifier is established before any VP exists', () => {
    expect(agentDid.startsWith('did:key:')).toBe(true);
    expect(DEMO_USER_DID).toBe('did:web:traveler.example');
    // Nothing has been granted or prompted yet.
    expect(airline.spApp.counters.grantsIssued).toBe(0);
    expect(airline.spApp.counters.scopeResolutions).toBe(0);
  });

  it('step 2: search is open — no consent prompt, no scope failure (register D7)', async () => {
    const result = await callSpTool({
      client,
      agentDid,
      userDid: DEMO_USER_DID,
      spMcpUrl: airline.mcpUrl,
      serviceDid: airline.serviceDid,
      toolName: 'search_flights',
      args: { origin: 'TVM', destination: 'DEL' },
      onConsentRequired: refuseToPrompt,
    });

    expect(result.ok).toBe(true);
    expect(result.consentPrompted).toBe(false);
    // TVM-DEL carries 3 flights in the demo inventory; no date/carrier filter narrows it.
    expect((result.data as { flights: unknown[] }).flights).toHaveLength(3);
    // Searching never asks for consent and never issues anything.
    expect(airline.spApp.counters.consentRequired).toBe(0);
    expect(airline.spApp.counters.grantsIssued).toBe(0);
    expect(airline.spApp.counters.scopeResolutions).toBe(0);
  });

  it('step 3: first Airline booking prompts for consent, issues a grant, then succeeds', async () => {
    const result = await callSpTool({
      client,
      agentDid,
      userDid: DEMO_USER_DID,
      spMcpUrl: airline.mcpUrl,
      serviceDid: airline.serviceDid,
      toolName: 'book_flight',
      args: { flightId: 'HA401' },
      onConsentRequired: acceptAllConsent(airline),
    });

    expect(result.ok).toBe(true);
    expect(result.consentPrompted).toBe(true);
    expect((result.data as { status: string }).status).toBe('CONFIRMED');

    expect(airline.spApp.counters.consentRequired).toBe(1);
    expect(airline.spApp.counters.grantsIssued).toBe(1);
    expect(airline.spApp.counters.scopeResolutions).toBe(1);

    // The VP that succeeded carried [agentVC, grantVC]. The agent holds
    // nothing; the platform recorded the grant when the SP finalized it.
    expect(await heldGrants(client, agentDid, DEMO_USER_DID)).toHaveLength(1);
    const grant = await heldGrant(client, agentDid, airline.serviceDid, DEMO_USER_DID);
    expect(grant).toBeDefined();
  });

  it('step 4: the Hotel SP is independent — its own prompt, its own grant', async () => {
    const airlineGrantsBefore = airline.spApp.counters.grantsIssued;

    const result = await callSpTool({
      client,
      agentDid,
      userDid: DEMO_USER_DID,
      spMcpUrl: hotel.mcpUrl,
      serviceDid: hotel.serviceDid,
      toolName: 'book_hotel',
      args: { hotelId: 'HS-DEL-1' },
      onConsentRequired: acceptAllConsent(hotel),
    });

    expect(result.ok).toBe(true);
    expect(result.consentPrompted).toBe(true);
    expect(hotel.spApp.counters.grantsIssued).toBe(1);

    // The Airline's grant was neither used nor disturbed.
    expect(airline.spApp.counters.grantsIssued).toBe(airlineGrantsBefore);
    const hotelGrant = await heldGrant(client, agentDid, hotel.serviceDid, DEMO_USER_DID);
    const airlineGrant = await heldGrant(client, agentDid, airline.serviceDid, DEMO_USER_DID);
    expect(hotelGrant?.id).not.toBe(airlineGrant?.id);
  });

  it('step 5 (NON-NEGOTIABLE): second Airline booking reuses the standing grant — zero new grants, zero widget renders', async () => {
    const grantsBefore = airline.spApp.counters.grantsIssued;
    const rendersBefore = airline.spApp.counters.scopeResolutions;
    const consentRequiredBefore = airline.spApp.counters.consentRequired;

    const result = await callSpTool({
      client,
      agentDid,
      userDid: DEMO_USER_DID,
      spMcpUrl: airline.mcpUrl,
      serviceDid: airline.serviceDid,
      toolName: 'book_flight',
      args: { flightId: 'HA733' },
      // If the flow tries to prompt, this throws and the test fails.
      onConsentRequired: refuseToPrompt,
    });

    expect(result.ok).toBe(true);
    expect((result.data as { status: string }).status).toBe('CONFIRMED');

    // The assertion this epic exists to make: not "booking succeeded", but
    // "nothing was issued and nothing was rendered".
    expect(result.consentPrompted).toBe(false);
    expect(airline.spApp.counters.grantsIssued - grantsBefore).toBe(0);
    expect(airline.spApp.counters.scopeResolutions - rendersBefore).toBe(0);
    expect(airline.spApp.counters.consentRequired - consentRequiredBefore).toBe(0);

    // Still exactly one Airline grant on the platform — reused, not re-issued.
    expect(await heldGrants(client, agentDid, DEMO_USER_DID)).toHaveLength(2); // Airline + Hotel
  });

  it('step 5 also holds for a different scope covered by the same grant', async () => {
    const grantsBefore = airline.spApp.counters.grantsIssued;

    const result = await callSpTool({
      client,
      agentDid,
      userDid: DEMO_USER_DID,
      spMcpUrl: airline.mcpUrl,
      serviceDid: airline.serviceDid,
      toolName: 'modify_booking',
      args: { bookingId: 'FLT-TEST' },
      onConsentRequired: refuseToPrompt,
    });

    expect(result.ok).toBe(true);
    expect(result.consentPrompted).toBe(false);
    expect(airline.spApp.counters.grantsIssued - grantsBefore).toBe(0);
  });
});

describe('Epic 5 Part H — route contracts', () => {
  it('C2: the scope route returns the full catalog regardless of agentDid (register D4)', async () => {
    const first = await fetch(`${airline.baseUrl}/api/consent/scopes?agentDid=did:key:zAgentOne`);
    const second = await fetch(`${airline.baseUrl}/api/consent/scopes?agentDid=did:key:zAgentTwo`);
    const none = await fetch(`${airline.baseUrl}/api/consent/scopes`);

    const a = (await first.json()) as { scopeOptions: Array<{ scope: string }> };
    const b = (await second.json()) as { scopeOptions: Array<{ scope: string }> };
    const c = (await none.json()) as { scopeOptions: Array<{ scope: string }> };

    expect(a.scopeOptions.map((o) => o.scope).sort()).toEqual(b.scopeOptions.map((o) => o.scope).sort());
    expect(a.scopeOptions.map((o) => o.scope).sort()).toEqual(c.scopeOptions.map((o) => o.scope).sort());
  });

  it('C2: the catalog is curated ∪ MCP tool scopes ∪ accept-terms', async () => {
    const res = await fetch(`${airline.baseUrl}/api/consent/scopes?agentDid=${encodeURIComponent(agentDid)}`);
    const { scopeOptions } = (await res.json()) as {
      scopeOptions: Array<{ scope: string; label: string; required?: boolean }>;
    };

    const scopes = scopeOptions.map((option) => option.scope).sort();
    expect(scopes).toEqual([SCOPES.BOOK_FLIGHTS, SCOPES.MODIFY_BOOKING, 'accept-terms'].sort());
    // The open search tool contributes nothing (register D7).
    expect(scopes).not.toContain('search:flights');
    expect(scopeOptions.find((o) => o.scope === 'accept-terms')?.required).toBe(true);
    expect(scopeOptions.every((option) => option.label.length > 0)).toBe(true);
  });

  it('C2: the Hotel SP advertises only its own catalog', async () => {
    const res = await fetch(`${hotel.baseUrl}/api/consent/scopes?agentDid=${encodeURIComponent(agentDid)}`);
    const { scopeOptions } = (await res.json()) as { scopeOptions: Array<{ scope: string }> };
    expect(scopeOptions.map((o) => o.scope).sort()).toEqual([SCOPES.BOOK_HOTEL, 'accept-terms'].sort());
  });

  it('C3: grant issuance persists BOTH the grant VC and the updated status list', async () => {
    const persisted = JSON.parse(await readFile(airline.stateFile, 'utf8')) as {
      statusList: { credentialSubject: { encodedList: string } };
      grants: Array<{ grantVC: { id: string }; agentDid: string; userDid: string; durability: string }>;
    };

    expect(persisted.grants.length).toBeGreaterThanOrEqual(1);
    expect(persisted.grants[0]?.agentDid).toBe(agentDid);
    expect(persisted.grants[0]?.userDid).toBe(DEMO_USER_DID);
    expect(persisted.grants[0]?.durability).toBe('standing');
    expect(persisted.statusList.credentialSubject.encodedList).toBeTruthy();
  });

  it('C3: the SP private key never leaves the server — not in the consent page, not in any response', async () => {
    const identity = JSON.parse(
      await readFile(join(workDir, 'sp-airline.identity.json'), 'utf8'),
    ) as { privateKeyHex: string };

    const page = await (await fetch(`${airline.baseUrl}/consent?agentDid=${encodeURIComponent(agentDid)}`)).text();
    const didDoc = await (await fetch(`${airline.baseUrl}/.well-known/did.json`)).text();
    const statusList = await (await fetch(`${airline.baseUrl}/status-list/1`)).text();
    const scopes = await (await fetch(`${airline.baseUrl}/api/consent/scopes?agentDid=x`)).text();

    for (const body of [page, didDoc, statusList, scopes]) {
      expect(body).not.toContain(identity.privateKeyHex);
    }
  });

  it('hosts the two artifacts a verifier needs: did:web document and status list', async () => {
    const didDoc = (await (await fetch(`${airline.baseUrl}/.well-known/did.json`)).json()) as {
      id: string;
      verificationMethod: unknown[];
    };
    expect(didDoc.id).toBe(airline.serviceDid);
    expect(didDoc.verificationMethod).toHaveLength(1);

    const statusList = (await (await fetch(`${airline.baseUrl}/status-list/1`)).json()) as {
      type: string[];
      credentialSubject: { statusPurpose: string };
    };
    expect(statusList.type).toContain('BitstringStatusListCredential');
    expect(statusList.credentialSubject.statusPurpose).toBe('revocation');
  });

  it('C1: a booking without any presentation is refused with CONSENT_REQUIRED', async () => {
    const res = await fetch(airline.mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'book_flight', arguments: { flightId: 'HA401' } },
      }),
    });
    const body = (await res.json()) as { error?: { data?: { code?: string; reason?: string } } };
    expect(body.error?.data?.code).toBe('CONSENT_REQUIRED');
    expect(body.error?.data?.reason).toBe('NO_PRESENTATION');
  });

  it("C1: one SP's grant does not authorize the other SP (grants are per-service)", async () => {
    // Present the Airline grant to the Hotel SP by targeting the Hotel with a
    // VP the Airline grant cannot satisfy.
    const result = await callSpTool({
      client,
      agentDid,
      userDid: DEMO_USER_DID,
      spMcpUrl: hotel.mcpUrl,
      serviceDid: hotel.serviceDid,
      toolName: 'book_hotel',
      args: { hotelId: 'HS-DEL-2' },
      onConsentRequired: refuseToPrompt,
    });
    // Succeeds using the HOTEL's own grant from step 4 — not the Airline's.
    expect(result.ok).toBe(true);
    expect(result.consentPrompted).toBe(false);

    const airlineGrant = await heldGrant(client, agentDid, airline.serviceDid, DEMO_USER_DID);
    const hotelGrant = await heldGrant(client, agentDid, hotel.serviceDid, DEMO_USER_DID);
    expect(airlineGrant!.issuer).toBe(airline.serviceDid);
    expect(hotelGrant!.issuer).toBe(hotel.serviceDid);
    expect(airlineGrant!.issuer).not.toBe(hotelGrant!.issuer);
  });

  it('C1: a grant for a different End User does not satisfy the user-match rule', async () => {
    const result = await callSpTool({
      client,
      agentDid,
      // Same agent, same SP, but a different End User than the grant captured.
      userDid: 'did:web:someone-else.example',
      spMcpUrl: airline.mcpUrl,
      serviceDid: airline.serviceDid,
      toolName: 'book_flight',
      args: { flightId: 'HA401' },
      onConsentRequired: async () => null,
    }).catch((error: unknown) => error);

    // No grant exists for that user, so the SP refuses and the (declining)
    // handler aborts the call rather than the booking silently succeeding.
    expect((result as Error).name).toBe('ConsentDeclinedError');
  });
});
