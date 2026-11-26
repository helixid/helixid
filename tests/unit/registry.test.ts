// Copyright 2026 DgVerse LLP
// Registry v3 (2026-11-24): "Make discoverable" at onboarding on the open-source server.
import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { RegistryEntryRepository, type OnboardingResult } from '@helixid/core';
import { registryOnboarding } from '../../src/registry.js';

const DID = 'did:web:127.0.0.1%3A3200:agents:a';
const request = (body: unknown) => ({ body, headers: {} }) as unknown as FastifyRequest;
const active = (did: string, subjectType = 'agent', status = 'active') => ({ did, subjectType, status }) as unknown as OnboardingResult;

function make() {
  const entries = new RegistryEntryRepository();
  const publisher = { publish: vi.fn(async () => 'holder_signs' as const) };
  return { entries, publisher, onboarding: registryOnboarding({ entries, publisher }) };
}

describe('registryOnboarding (helixid)', () => {
  it('refuses a discoverable that is not a boolean, before anything is created', () => {
    const { onboarding } = make();
    expect(() => onboarding.check(request({ discoverable: 'yes' }))).toThrow(/discoverable must be true or false/);
    expect(() => onboarding.check(request({ discoverable: false }))).not.toThrow();
    expect(() => onboarding.check(request(undefined))).not.toThrow();
    expect(() => onboarding.check(request(['x']))).not.toThrow();
  });

  it('records the choice, discoverable by default', async () => {
    const { onboarding, entries } = make();
    await onboarding.created(request({ name: 'A' }), DID);
    expect((await entries.get(DID))?.discoverable).toBe(true);
    await onboarding.created(request({ discoverable: false }), `${DID}2`);
    expect((await entries.get(`${DID}2`))?.discoverable).toBe(false);
  });

  it('registers a discoverable agent with the Helix registry once it is active, and nothing else', async () => {
    const { onboarding, entries, publisher } = make();
    await entries.set(DID, true);
    await entries.set(`${DID}2`, false);
    await onboarding.activated(active(DID));
    await onboarding.activated(active(`${DID}2`));
    await onboarding.activated(active(`${DID}3`, 'service'));
    await onboarding.activated(active(`${DID}4`, 'agent', 'pending_key'));
    // No choice recorded (an agent onboarded before registry v3): the default, discoverable.
    await onboarding.activated(active(`${DID}5`));
    expect(publisher.publish.mock.calls).toEqual([[DID], [`${DID}5`]]);
  });
});
