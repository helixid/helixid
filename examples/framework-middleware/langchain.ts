// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//    http://www.apache.org/licenses/LICENSE-2.0
//
// The LangChain adapter (@helixid/langchain): HelixIDToolWrapper wraps a
// tool so every MCP request it sends is signed with the agent's own key, a
// fresh KYA-OS request proof bound to that request and service, with the
// agent's delegation chain attached (story C-C). The tool never sees the key;
// the model never sees the proof. On the other side, the MCP server's gate
// (@helixid/mcp-middleware) verifies it in-process.

import 'dotenv/config';
import { HelixIDToolWrapper, signCurrentRequest, type StructuredToolLike } from '@helixid/langchain';
import { helixidMCPMiddleware } from '@helixid/mcp-middleware';
import { agentSigner, logStep, requireAgentIdentity, serviceVerifier } from './shared.js';

async function main(): Promise<void> {
  const identity = await requireAgentIdentity();
  logStep('LangChain', `Acting as ${identity.agentDid} at ${identity.serviceDid}.`);

  // The service side: the gate an MCP server puts in front of its tools.
  const gate = helixidMCPMiddleware({
    verifier: await serviceVerifier(identity.serviceDid),
    toolScopes: { 'orders.lookup': ['read:orders'], 'inventory.adjust': ['write:inventory'] },
  });

  // A tool that calls the orders MCP server: it signs the request it sends with signCurrentRequest.
  const ordersTool: StructuredToolLike = {
    name: 'orders.lookup',
    async _call(input: unknown): Promise<string> {
      const request = await signCurrentRequest({ name: 'orders.lookup', arguments: input as Record<string, unknown> });
      const params = request.params as { name: string; arguments: Record<string, unknown>; _meta: Record<string, unknown> };
      logStep('Orders Tool', `Signed request carries ${Object.keys(params._meta).join(' and ')}.`);
      // What the MCP server does on receipt:
      const caller = await gate.authorize({ name: params.name, input: params.arguments, _meta: params._meta, request });
      logStep('Orders MCP', `Verified ${caller.agentDid ?? 'caller'} at ${caller.level}; scopes ${caller.scopes.join(', ')}.`);
      return 'order ORD-1001 is ready for fulfillment';
    },
  };
  const signer = await agentSigner(identity);
  const wrapped = HelixIDToolWrapper(ordersTool, { signer, audience: identity.serviceDid, chain: identity.chain });
  logStep('LangChain', `Wrapped tool completed: ${String(await wrapped._call({ orderId: 'ORD-1001' }))}.`);

  // The same agent asking for a tool its chain does not cover is refused at the gate.
  const inventoryTool: StructuredToolLike = {
    name: 'inventory.adjust',
    async _call(input: unknown): Promise<string> {
      const request = await signCurrentRequest({ name: 'inventory.adjust', arguments: input as Record<string, unknown> });
      const params = request.params as { name: string; arguments: Record<string, unknown>; _meta: Record<string, unknown> };
      await gate({ name: params.name, input: params.arguments, _meta: params._meta, request });
      return 'adjusted';
    },
  };
  try {
    await HelixIDToolWrapper(inventoryTool, { signer, audience: identity.serviceDid, chain: identity.chain })._call({ sku: 'SKU-1001', delta: -1 });
    logStep('LangChain', 'inventory.adjust: UNEXPECTEDLY allowed');
    process.exitCode = 1;
  } catch (error: unknown) {
    logStep('LangChain', `inventory.adjust refused as expected: ${(error as Error).message}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
