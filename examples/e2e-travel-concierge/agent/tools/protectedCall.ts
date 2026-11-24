// The single choke point where a tool call is signed (KYA-OS stories C-C,
// F-2). The selected persona signs a request proof with its own key (self
// custody, locally) naming the service as audience, and carries the chain it
// holds there: the root hop its responsible party issued, or that root plus
// the hop a delegating agent signed. The MCP server verifies both in-process.
// No chain: the agent proves who it is, with no authority at the service.
import { kyaos } from '@helixid/sdk-js';
import { sendMcpCall } from '../mcpClient.js';
import { getPersona } from '../../personas/store.js';
import { publishOwnStatusList, signerOf } from '../../personas/keys.js';
import { loadService } from '../../service/identity.js';
import type { Persona } from '../../personas/types.js';

export interface ProtectedResult {
  success: boolean;
  detail: string;
  code?: string;
  data?: unknown;
}

export async function callProtectedTool(
  persona: Persona,
  toolName: string,
  input: Record<string, unknown>,
): Promise<ProtectedResult> {
  const service = await loadService();
  // A hop a self-custody agent delegated is read against that agent's own list, which it keeps signed.
  for (const hop of persona.chain?.slice(1) ?? []) {
    const delegator = persona.delegatedFromPersonaId ? getPersona(persona.delegatedFromPersonaId) : undefined;
    if (delegator && delegator.agentDid === hop.issuer) await publishOwnStatusList(delegator);
  }
  const call = await kyaos.withRequestProof({ method: 'tools/call', params: { name: toolName, arguments: input } }, await signerOf(persona), {
    audience: service.did,
    ...(persona.chain && persona.chain.length > 0 ? { chain: persona.chain } : {}),
  });
  const result = await sendMcpCall(call as { method: string; params: Record<string, unknown> });
  // Surface the real result (success or the real refusal) so the model reports
  // it truthfully -- the agent never writes the outcome itself.
  const code = (result.structured as { code?: string } | undefined)?.code;
  return {
    success: !result.isError,
    detail: result.text,
    ...(result.isError ? { code: code ?? 'REFUSED' } : { data: result.structured }),
  };
}
