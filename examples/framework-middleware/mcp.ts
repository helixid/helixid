import 'dotenv/config';
import { attachHelixVP, helixidMCPMiddleware } from '@helixid/mcp-middleware';
import type { SignedVP } from '@helixid/sdk-js';
import {
  createHelixClient,
  extractScopes,
  logStep,
  requireAgentIdentity,
  targetService,
  userDid,
  verifyWithScopes,
} from './shared.js';

async function main(): Promise<void> {
  const client = createHelixClient();
  const { agentDid } = await requireAgentIdentity();

  const realVerifier = {
    verifySessionToken: client.verifySessionToken.bind(client),
  };

  logStep('MCP', `Acting as ${agentDid}.`);
  logStep('MCP', `Attaching a real HelixVP to tool input for ${targetService}.`);
  const outboundCall = await attachHelixVP(
    { name: 'orders.lookup', input: { orderId: 'ORD-1001' } },
    {
      client,
      agentDid,
      userDid,
      targetService,
    },
  );

  logStep(
    'MCP',
    `_helixVP attached to tool input (vpId: ${(outboundCall.input?._helixVP as { id?: string })?.id ?? 'unknown'})`,
  );

  // Verification is API-mediated too, so the middleware needs the client.
  const requireReadOrders = helixidMCPMiddleware({
    client,
    requiredScopes: ['read:orders'],
    allowSelfSigned: false,
  });

  // Call the middleware with the full tool call (it expects toolCall.input._helixVP)
  const accepted = await requireReadOrders(outboundCall as any);
  logStep('MCP', `Allowed request: ${JSON.stringify(accepted)}`);

  const deniedCall = await attachHelixVP(
    { name: 'inventory.admin', input: { sku: 'SKU-1001' } },
    {
      client,
      agentDid,
      userDid,
      targetService,
    },
  );
  const requireWriteInventory = helixidMCPMiddleware({ client, requiredScopes: ['write:inventory'] });
  try {
    await requireWriteInventory(deniedCall as any);
    logStep('MCP', 'Denied request: unexpectedly allowed');
  } catch (err: unknown) {
    logStep('MCP', `Denied request: ${(err as Error).message}`);
  }

  const signedVP = outboundCall.input?._helixVP as SignedVP | undefined;
  if (signedVP) {
    logStep('MCP', `Outbound VP scopes: ${extractScopes(signedVP).join(', ')}.`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
