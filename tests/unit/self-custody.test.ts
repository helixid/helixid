import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { custodyRoutes, type CustodyAction } from '@helixid/core';
import {
  SELF_CUSTODY_ONLY_CODE,
  SelfCustodyOnlyError,
  SelfCustodyOnlyKeyStore,
  selfCustodyAuthorize,
} from '../../src/self-custody.js';

const ADMIN = 'admin-key';
const DID = 'did:web:helix.example:agents:a';

function request(body: unknown, adminKey?: string | string[]): FastifyRequest {
  return { body, headers: adminKey === undefined ? {} : { 'x-admin-api-key': adminKey } } as unknown as FastifyRequest;
}

describe('SelfCustodyOnlyKeyStore', () => {
  const store = new SelfCustodyOnlyKeyStore();

  it('refuses to generate or sign: helixid holds no private key', async () => {
    await expect(store.generate()).rejects.toMatchObject({ code: SELF_CUSTODY_ONLY_CODE, httpStatus: 400 });
    await expect(store.sign()).rejects.toBeInstanceOf(SelfCustodyOnlyError);
  });

  it('finds nothing: no public key, nothing to shred, no keys listed', async () => {
    expect(await store.publicJwk()).toBeNull();
    expect(await store.shred()).toBe(false);
    expect(await store.list()).toEqual([]);
  });
});

describe('selfCustodyAuthorize', () => {
  const authorize = selfCustodyAuthorize(ADMIN);

  it.each<CustodyAction>([
    { action: 'createAgent' },
    { action: 'createOwner' },
    { action: 'changeCustody', subjectType: 'agent', did: DID },
  ])("refuses keyCustody 'helix' on $action, before the admin key is checked", (action) => {
    expect(() => authorize(request({ name: 'a', keyCustody: 'helix' }), action)).toThrow(SelfCustodyOnlyError);
    expect(() => authorize(request({ name: 'a', keyCustody: 'helix' }, ADMIN), action)).toThrow(/self-custody only/);
  });

  it('refuses every custodial signature', () => {
    expect(() => authorize(request({ payload: 'AQ' }, ADMIN), { action: 'sign', subjectType: 'agent', did: DID })).toThrow(SelfCustodyOnlyError);
  });

  it('lets self-custody and default requests through with the admin key', () => {
    for (const body of [{ name: 'a', keyCustody: 'self' }, { name: 'a' }, undefined, null, 'text']) {
      expect(() => authorize(request(body, ADMIN), { action: 'createAgent' })).not.toThrow();
    }
    expect(() => authorize(request(undefined, [ADMIN]), { action: 'report' })).not.toThrow();
    expect(() => authorize(request({ keyCustody: 'self' }, ADMIN), { action: 'changeCustody', subjectType: 'agent', did: DID })).not.toThrow();
  });

  it('needs the admin key otherwise, as core does by default', () => {
    expect(() => authorize(request({ name: 'a' }), { action: 'createAgent' })).toThrow(expect.objectContaining({ code: 'ADMIN_AUTH_REQUIRED', httpStatus: 403 }));
    expect(() => authorize(request({ name: 'a' }, 'wrong'), { action: 'createAgent' })).toThrow(expect.objectContaining({ code: 'ADMIN_AUTH_REQUIRED' }));
    expect(() => selfCustodyAuthorize(undefined)(request({ name: 'a' }, ADMIN), { action: 'defaults' })).toThrow(expect.objectContaining({ code: 'ADMIN_AUTH_REQUIRED' }));
  });
});

describe("core's custody routes with helixid's hook", () => {
  async function app() {
    const service = {
      createAgent: vi.fn(async () => ({ did: DID, keyCustody: 'self', didHosting: 'helix', status: 'pending_key', enrollmentToken: 'enroll:x' })),
      sign: vi.fn(),
      changeCustody: vi.fn(),
      createOwner: vi.fn(),
    };
    const instance = Fastify({ logger: false });
    await instance.register(custodyRoutes, { prefix: '/v1', custodyService: service as never, authorize: selfCustodyAuthorize(ADMIN) });
    return { instance, service };
  }

  const post = (instance: Awaited<ReturnType<typeof app>>['instance'], url: string, payload: unknown) =>
    instance.inject({ method: 'POST', url, payload: payload as never, headers: { 'x-admin-api-key': ADMIN } });

  it("answers keyCustody 'helix' and /sign with a clear 400, and the service is never called", async () => {
    const { instance, service } = await app();
    for (const [url, payload] of [
      ['/v1/agents', { name: 'Custodial', keyCustody: 'helix' }],
      ['/v1/owners', { name: 'Owner', keyCustody: 'helix' }],
      [`/v1/agents/${encodeURIComponent(DID)}/custody`, { keyCustody: 'helix' }],
      [`/v1/agents/${encodeURIComponent(DID)}/sign`, { payload: 'AQ' }],
    ] as const) {
      const res = await post(instance, url, payload);
      expect(res.statusCode, url).toBe(400);
      expect(res.json(), url).toMatchObject({ error: { code: SELF_CUSTODY_ONLY_CODE, message: expect.stringMatching(/self-custody only|no private keys/) } });
    }
    expect(service.createAgent).not.toHaveBeenCalled();
    expect(service.createOwner).not.toHaveBeenCalled();
    expect(service.changeCustody).not.toHaveBeenCalled();
    expect(service.sign).not.toHaveBeenCalled();
  });

  it('creates a self-custody agent and returns its enrollment token', async () => {
    const { instance, service } = await app();
    const res = await post(instance, '/v1/agents', { name: 'Self', keyCustody: 'self' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ keyCustody: 'self', enrollmentToken: 'enroll:x' });
    expect(service.createAgent).toHaveBeenCalledTimes(1);
  });
});
