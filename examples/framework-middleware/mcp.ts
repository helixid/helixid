// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//    http://www.apache.org/licenses/LICENSE-2.0
//
// The MCP gate (@helixid/mcp-middleware) on its own: an agent signs an MCP
// tools/call with kyaos.withRequestProof (its own key, its chain in
// params._meta); the server's helixidMCPMiddleware verifies it in-process
// (story F-2: DID documents, cards and status lists read from their
// publishers) and lets it through, or refuses it with the verifier's reason.

import 'dotenv/config';
import { kyaos } from '@helixid/sdk-js';
import { helixidMCPMiddleware } from '@helixid/mcp-middleware';
import { agentSigner, logStep, requireAgentIdentity, serviceVerifier } from './shared.js';

async function main(): Promise<void> {
  const identity = await requireAgentIdentity();
  const signer = await agentSigner(identity);
  logStep('MCP', `Acting as ${identity.agentDid} at ${identity.serviceDid}.`);

  const gate = helixidMCPMiddleware({
    verifier: await serviceVerifier(identity.serviceDid),
    toolScopes: { 'orders.lookup': ['read:orders'], 'inventory.admin': ['write:inventory'] },
  });
  interface SignedCall {
    method: string;
    params: { name: string; arguments: Record<string, unknown>; _meta: Record<string, unknown> };
  }
  const sign = async (name: string, args: Record<string, unknown>): Promise<SignedCall> =>
    (await kyaos.withRequestProof({ name, arguments: args }, signer, { audience: identity.serviceDid, chain: identity.chain })) as SignedCall;

  const lookup = await sign('orders.lookup', { orderId: 'ORD-1001' });
  const caller = await gate.authorize({ name: lookup.params.name, input: lookup.params.arguments, _meta: lookup.params._meta, request: lookup });
  logStep('MCP', `Allowed: ${caller.agentDid} at ${caller.level}, scopes ${caller.scopes.join(', ')}.`);

  const replay = gate.authorize({ name: lookup.params.name, input: lookup.params.arguments, _meta: lookup.params._meta, request: lookup });
  await replay.then(
    () => {
      logStep('MCP', 'The same request again: UNEXPECTEDLY allowed');
      process.exitCode = 1;
    },
    (error: unknown) => logStep('MCP', `The same request again is refused: ${(error as Error).message}`),
  );

  const admin = await sign('inventory.admin', { sku: 'SKU-1001' });
  try {
    await gate({ name: admin.params.name, input: admin.params.arguments, _meta: admin.params._meta, request: admin });
    logStep('MCP', 'inventory.admin: UNEXPECTEDLY allowed');
    process.exitCode = 1;
  } catch (error: unknown) {
    logStep('MCP', `inventory.admin refused as expected: ${(error as Error).message}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
