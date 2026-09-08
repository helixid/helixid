// Cross-epic suite §7 — Cross-SP Isolation (ISO1–ISO6), plus §5 REV8 and
// §8 UX11/UX13, which are only testable with two live SPs in one run.
//
// This category has no prior coverage: it does not exist as a concern until
// Epic 5 puts two independent SPs behind one agent. Every case here is [NEW].

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearDIDCache,
  HelixClient,
  revokeGrant,
  VPBuilder,
  verifyVP,
  type SignedVC,
} from '@helixid/sdk-js';
import { DEMO_USER_DID, SCOPES } from '../helixid-config/index.js';
import { callSpTool } from '../agent/consentAwareCall.js';
import { grantConsent, heldGrant, startHarness, type Harness } from './harness.js';

let helixClient: HelixClient;

const AIRLINE_PORT = 14201;
const HOTEL_PORT = 14202;

let h: Harness;
const refuseToPrompt = async (): Promise<SignedVC> => {
  throw new Error('consent must not be requested here');
};

beforeAll(async () => {
  clearDIDCache();
  h = await startHarness(AIRLINE_PORT, HOTEL_PORT);
  helixClient = new HelixClient(h.helixApiUrl);
  // Establish one grant per SP for the same (agent, user) pair.
  // Nothing to store agent-side: the platform records each grant when the
  // issuing SP finalizes it.
  await grantConsent(h.airline, h.agentDid, DEMO_USER_DID);
  await grantConsent(h.hotel, h.agentDid, DEMO_USER_DID);
}, 60_000);

afterAll(async () => {
  await h.stop();
});

describe('§7 Cross-SP isolation', () => {
  it('ISO1: a VP bound to the Airline is rejected by the Hotel on targetService alone', async () => {
    const airlineGrant = (await heldGrant(
      h.client,
      h.agentDid,
      h.airline.serviceDid,
      DEMO_USER_DID,
    ))!;

    // Bound to the Airline, but verified by the Hotel. Signed by the API on
    // the agent's behalf — the agent has no key of its own.
    const vp = await h.client.signVP(h.agentDid, h.airline.serviceDid, {
      userDid: DEMO_USER_DID,
      grantVC: airlineGrant,
    });

    await expect(
      verifyVP(vp, helixClient, { expectedTargetService: h.hotel.serviceDid }),
    ).rejects.toMatchObject({ code: 'VP_INVALID_STRUCTURE' });
  });

  it("ISO1b: the Airline's grant cannot authorize a Hotel booking even in a correctly-targeted VP", async () => {
    const airlineGrant = (await heldGrant(
      h.client,
      h.agentDid,
      h.airline.serviceDid,
      DEMO_USER_DID,
    ))!;

    // Correctly targeted at the Hotel, but carrying the Airline's grant.
    const vp = await h.client.signVP(h.agentDid, h.hotel.serviceDid, {
      userDid: DEMO_USER_DID,
      grantVC: airlineGrant,
    });

    const res = await fetch(h.hotel.mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'book_hotel', arguments: { hotelId: 'HS-DEL-1', _helixVP: vp } },
      }),
    });
    const body = (await res.json()) as { error?: { data?: { code?: string; reason?: string } } };
    expect(body.error?.data?.code).toBe('CONSENT_REQUIRED');
    expect(body.error?.data?.reason).toBe('NO_GRANT_FOR_THIS_SERVICE');
  });

  it("ISO2: the Airline's catalog never includes Hotel-only scopes", async () => {
    const airlineRes = await fetch(`${h.airline.baseUrl}/api/consent/scopes?agentDid=x`);
    const hotelRes = await fetch(`${h.hotel.baseUrl}/api/consent/scopes?agentDid=x`);
    const airline = (await airlineRes.json()) as { scopeOptions: Array<{ scope: string }> };
    const hotel = (await hotelRes.json()) as { scopeOptions: Array<{ scope: string }> };

    const airlineScopes = airline.scopeOptions.map((o) => o.scope);
    const hotelScopes = hotel.scopeOptions.map((o) => o.scope);

    expect(airlineScopes).not.toContain(SCOPES.BOOK_HOTEL);
    expect(hotelScopes).not.toContain(SCOPES.BOOK_FLIGHTS);
    expect(hotelScopes).not.toContain(SCOPES.MODIFY_BOOKING);
    // The only overlap is the resolver-appended terms entry.
    const overlap = airlineScopes.filter((scope) => hotelScopes.includes(scope));
    expect(overlap).toEqual(['accept-terms']);
  });

  it('ISO3: revoking the Airline grant leaves the Hotel grant untouched', async () => {
    const airlineGrant = (await heldGrant(
      h.client,
      h.agentDid,
      h.airline.serviceDid,
      DEMO_USER_DID,
    ))!;

    // The SP's own revocation operation: flip the bit, re-sign, persist.
    const identity = h.airline;
    const updated = await revokeGrant(
      identity.store.getStatusList(),
      {
        did: identity.serviceDid,
        privateKeyHex: JSON.parse(
          await (await import('node:fs/promises')).readFile(
            `${h.workDir}/sp-airline.identity.json`,
            'utf8',
          ),
        ).privateKeyHex as string,
      },
      { vc: airlineGrant },
    );
    await identity.store.replaceStatusList(updated);

    // Airline booking now fails closed. Note the failure is a verification
    // rejection (VC_REVOKED), not a consent prompt — a revoked grant is not
    // "needs consent", and the SP must not invite the user to re-consent
    // around a revocation.
    const airlineResult = await callSpTool({
      client: h.client,
      agentDid: h.agentDid,
      userDid: DEMO_USER_DID,
      spMcpUrl: h.airline.mcpUrl,
      serviceDid: h.airline.serviceDid,
      toolName: 'book_flight',
      args: { flightId: 'HA401' },
      onConsentRequired: refuseToPrompt,
    });
    expect(airlineResult.ok).toBe(false);
    expect(airlineResult.consentPrompted).toBe(false);
    expect(airlineResult.error?.code).toBe('VP_INVALID');
    expect(airlineResult.error?.reason).toBe('VC_REVOKED');

    // ...while the Hotel grant, on its own independent status list, still works.
    const hotelResult = await callSpTool({
      client: h.client,
      agentDid: h.agentDid,
      userDid: DEMO_USER_DID,
      spMcpUrl: h.hotel.mcpUrl,
      serviceDid: h.hotel.serviceDid,
      toolName: 'book_hotel',
      args: { hotelId: 'HS-DEL-2' },
      onConsentRequired: refuseToPrompt,
    });
    expect(hotelResult.ok).toBe(true);
    expect(hotelResult.consentPrompted).toBe(false);
  });

  it('ISO4: both SPs resolve independently — distinct DIDs, distinct status lists, no ID collision', async () => {
    expect(h.airline.serviceDid).not.toBe(h.hotel.serviceDid);

    const airlineDoc = (await (await fetch(`${h.airline.baseUrl}/.well-known/did.json`)).json()) as {
      id: string;
      verificationMethod: Array<{ publicKeyMultibase: string }>;
    };
    const hotelDoc = (await (await fetch(`${h.hotel.baseUrl}/.well-known/did.json`)).json()) as {
      id: string;
      verificationMethod: Array<{ publicKeyMultibase: string }>;
    };

    expect(airlineDoc.id).toBe(h.airline.serviceDid);
    expect(hotelDoc.id).toBe(h.hotel.serviceDid);
    // Independent key material — not one identity served twice.
    expect(airlineDoc.verificationMethod[0]?.publicKeyMultibase).not.toBe(
      hotelDoc.verificationMethod[0]?.publicKeyMultibase,
    );

    const airlineList = (await (await fetch(`${h.airline.baseUrl}/status-list/1`)).json()) as {
      issuer: string;
      credentialSubject: { encodedList: string };
    };
    const hotelList = (await (await fetch(`${h.hotel.baseUrl}/status-list/1`)).json()) as {
      issuer: string;
      credentialSubject: { encodedList: string };
    };
    expect(airlineList.issuer).toBe(h.airline.serviceDid);
    expect(hotelList.issuer).toBe(h.hotel.serviceDid);
    // ISO3 revoked a bit on the Airline's list only.
    expect(airlineList.credentialSubject.encodedList).not.toBe(
      hotelList.credentialSubject.encodedList,
    );
  });

  it("ISO5: looking up one SP's grant never returns the other SP grant", async () => {
    const airlineGrant = await heldGrant(h.client, h.agentDid, h.airline.serviceDid, DEMO_USER_DID);
    const hotelGrant = await heldGrant(h.client, h.agentDid, h.hotel.serviceDid, DEMO_USER_DID);

    expect(airlineGrant).toBeDefined();
    expect(hotelGrant).toBeDefined();
    expect(airlineGrant!.id).not.toBe(hotelGrant!.id);
    expect(airlineGrant!.issuer).toBe(h.airline.serviceDid);
    expect(hotelGrant!.issuer).toBe(h.hotel.serviceDid);
    // A DID neither SP owns matches nothing.
    expect(
      await heldGrant(h.client, h.agentDid, 'did:web:unknown.example', DEMO_USER_DID),
    ).toBeUndefined();
  });

  it('ISO6: concurrent issuance at both SPs does not cross-contaminate their status lists', async () => {
    const airlineBefore = h.airline.store.getStatusList().credentialSubject.encodedList;
    const hotelBefore = h.hotel.store.getStatusList().credentialSubject.encodedList;
    const airlineGrantsBefore = h.airline.spApp.counters.grantsIssued;
    const hotelGrantsBefore = h.hotel.spApp.counters.grantsIssued;

    const [airlineGrant, hotelGrant] = await Promise.all([
      grantConsent(h.airline, h.agentDid, 'did:web:concurrent-user.example'),
      grantConsent(h.hotel, h.agentDid, 'did:web:concurrent-user.example'),
    ]);

    expect(airlineGrant.issuer).toBe(h.airline.serviceDid);
    expect(hotelGrant.issuer).toBe(h.hotel.serviceDid);
    expect(h.airline.spApp.counters.grantsIssued).toBe(airlineGrantsBefore + 1);
    expect(h.hotel.spApp.counters.grantsIssued).toBe(hotelGrantsBefore + 1);

    // Issuance sets no bits, so neither encodedList moved — and critically,
    // neither SP's list was replaced by the other's.
    expect(h.airline.store.getStatusList().credentialSubject.encodedList).toBe(airlineBefore);
    expect(h.hotel.store.getStatusList().credentialSubject.encodedList).toBe(hotelBefore);
    expect(h.airline.store.getStatusList().issuer).toBe(h.airline.serviceDid);
    expect(h.hotel.store.getStatusList().issuer).toBe(h.hotel.serviceDid);

    // Each SP persisted only its own grant.
    expect(
      h.airline.store.getGrants().every((g) => g.grantVC.issuer === h.airline.serviceDid),
    ).toBe(true);
    expect(h.hotel.store.getGrants().every((g) => g.grantVC.issuer === h.hotel.serviceDid)).toBe(
      true,
    );
  });
});

describe('§5 REV8 — no cross-SP bleed at the resolver layer', () => {
  it('each verification reads only its own SP status list', async () => {
    // The Airline's list has a revoked bit (ISO3); the Hotel's does not. If any
    // caching layer keyed lists loosely, one of these two would be wrong.
    const airlineGrant = (await heldGrant(
      h.client,
      h.agentDid,
      h.airline.serviceDid,
      DEMO_USER_DID,
    ))!;
    const hotelGrant = (await heldGrant(
      h.client,
      h.agentDid,
      h.hotel.serviceDid,
      DEMO_USER_DID,
    ))!;

    const airlineVP = await h.client.signVP(h.agentDid, h.airline.serviceDid, {
      userDid: DEMO_USER_DID,
      grantVC: airlineGrant,
    });

    const hotelVP = await h.client.signVP(h.agentDid, h.hotel.serviceDid, {
      userDid: DEMO_USER_DID,
      grantVC: hotelGrant,
    });

    await expect(
      verifyVP(airlineVP, helixClient, { expectedTargetService: h.airline.serviceDid }),
    ).rejects.toMatchObject({ code: 'VC_REVOKED' });

    await expect(
      verifyVP(hotelVP, helixClient, { expectedTargetService: h.hotel.serviceDid }),
    ).resolves.toMatchObject({ valid: true });
  });
});

describe('§8 Consent UX — route contract and server-side enforcement', () => {
  it('UX11: the scope route returns exactly { scopeOptions: ScopeOption[] }', async () => {
    const res = await fetch(`${h.airline.baseUrl}/api/consent/scopes?agentDid=x`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(Object.keys(body)).toEqual(['scopeOptions']);
    expect(Array.isArray(body['scopeOptions'])).toBe(true);
    for (const option of body['scopeOptions'] as Array<Record<string, unknown>>) {
      expect(typeof option['scope']).toBe('string');
      expect(typeof option['label']).toBe('string');
      const allowed = ['scope', 'label', 'description', 'defaultChecked', 'required'];
      expect(Object.keys(option).every((key) => allowed.includes(key))).toBe(true);
    }
  });

  it('UX13: the SP independently rejects a selection omitting a required scope', async () => {
    // UX8 covers the widget's UI constraint. This covers the SP not trusting
    // the client: a caller bypassing the widget entirely and POSTing a
    // selection with `accept-terms` missing must be rejected server-side.
    const res = await fetch(`${h.airline.baseUrl}/api/consent/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentDid: h.agentDid,
        userDid: 'did:web:ux13-user.example',
        scopes: [SCOPES.BOOK_FLIGHTS], // accept-terms deliberately omitted
        durability: 'standing',
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('MISSING_REQUIRED_SCOPE');
  });
});
