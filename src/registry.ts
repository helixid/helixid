// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//    http://www.apache.org/licenses/LICENSE-2.0

// Registry v3 (2026-11-24) on the open-source server.
//
// An agent onboarded here is made discoverable or not at onboarding:
// `discoverable` in the body of POST /v1/agents (the Console's "Make
// discoverable", on by default). A discoverable agent is listed in the Helix
// agent registry (api.helixid.dev) once it is active. helixid holds no
// private key, so it cannot sign the registration itself: the publisher logs
// that the holder registers it with the SDK (kyaos.registry.publish), and the
// Helix registry checks it against GET /agent/registry/:did here.

import { readDiscoverable, type HelixRegistryPublisher, type OnboardingResult, type RegistryEntryRepository } from '@helixid/core';
import type { FastifyRequest } from 'fastify';

function discoverableOf(request: FastifyRequest): boolean {
  const body = request.body;
  const fields = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return readDiscoverable(fields['discoverable']);
}

export interface RegistryOnboardingDeps {
  entries: Pick<RegistryEntryRepository, 'set' | 'get'>;
  publisher: Pick<HelixRegistryPublisher, 'publish'>;
}

export function registryOnboarding(deps: RegistryOnboardingDeps): {
  /** Refuses a `discoverable` that is not a boolean before anything is created. */
  check(request: FastifyRequest): void;
  /** Records the choice of a new agent. */
  created(request: FastifyRequest, did: string): Promise<void>;
  /** A discoverable agent that just became active is registered with the Helix registry. */
  activated(result: OnboardingResult): Promise<void>;
} {
  return {
    check(request) {
      discoverableOf(request);
    },
    async created(request, did) {
      await deps.entries.set(did, discoverableOf(request));
    },
    async activated(result) {
      if (result.subjectType !== 'agent' || result.status !== 'active') return;
      // The choice was recorded at creation (none recorded: the default, discoverable).
      if ((await deps.entries.get(result.did))?.discoverable ?? true) await deps.publisher.publish(result.did);
    },
  };
}
