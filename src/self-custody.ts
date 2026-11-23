// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//    http://www.apache.org/licenses/LICENSE-2.0

// Self-custody only (KYA-OS story F-3 on the open-source server).
//
// helixid hosts agents' DID documents and Entity Cards and onboards them
// through core's custody routes, but it never holds an agent's private key:
// the agent generates it and keeps it (`helix init`), and Helix only learns
// the public JWK. So the custody service gets a KeyStore that holds nothing,
// and the routes refuse, before anything is written, every request that
// would need one: a `keyCustody: 'helix'` create or custody change, and the
// custodial `/sign` route.

import {
  AdminAuthRequiredError,
  type CustodyAction,
  type KeyStore,
  type KeyStoreKeyInfo,
  type PublicKeyJwk,
} from '@helixid/core';
import type { FastifyRequest } from 'fastify';

export const SELF_CUSTODY_ONLY_CODE = 'CUSTODY_HELIX_UNAVAILABLE';

/**
 * A 400 with its own code. Shaped like core's HelixError (`code`,
 * `httpStatus`), which is what the custody routes map to a response; core's
 * ErrorCode union has no member for a build without custodial keys.
 */
export class SelfCustodyOnlyError extends Error {
  readonly code = SELF_CUSTODY_ONLY_CODE;
  readonly httpStatus = 400;

  constructor(message: string) {
    super(message);
    this.name = 'SelfCustodyOnlyError';
  }
}

const NO_HELIX_KEYS =
  "helixid is self-custody only: the agent generates and holds its own key (helix init); keyCustody 'helix' is not available";

/** A KeyStore that holds no key: generating or signing is refused; lookups find nothing. */
export class SelfCustodyOnlyKeyStore implements KeyStore {
  async generate(): Promise<PublicKeyJwk> {
    throw new SelfCustodyOnlyError(NO_HELIX_KEYS);
  }

  async sign(): Promise<Uint8Array> {
    throw new SelfCustodyOnlyError('helixid holds no private keys, so it signs nothing for an agent: sign with the agent\'s own key');
  }

  async publicJwk(): Promise<PublicKeyJwk | null> {
    return null;
  }

  async shred(): Promise<boolean> {
    return false;
  }

  async list(): Promise<KeyStoreKeyInfo[]> {
    return [];
  }
}

function asksForHelixCustody(request: FastifyRequest): boolean {
  const body = request.body;
  return typeof body === 'object' && body !== null && (body as Record<string, unknown>)['keyCustody'] === 'helix';
}

/**
 * The custody routes' `authorize` hook: the admin key, as core's default
 * checks it, after the self-custody refusals. The refusals come first so the
 * answer says why even without the key.
 */
export function selfCustodyAuthorize(adminApiKey: string | undefined): (request: FastifyRequest, action: CustodyAction) => void {
  return (request, action) => {
    if (action.action === 'sign') {
      throw new SelfCustodyOnlyError('helixid holds no private keys, so there is no custodial signing: sign with the agent\'s own key');
    }
    if ((action.action === 'createAgent' || action.action === 'createOwner' || action.action === 'changeCustody') && asksForHelixCustody(request)) {
      throw new SelfCustodyOnlyError(NO_HELIX_KEYS);
    }
    const submitted = request.headers['x-admin-api-key'];
    const submittedKey = Array.isArray(submitted) ? submitted[0] : submitted;
    if (!adminApiKey || submittedKey !== adminApiKey) throw new AdminAuthRequiredError();
  };
}
