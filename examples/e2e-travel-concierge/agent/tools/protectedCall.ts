// The single choke point where a verifiable presentation is created. It asks
// the API to sign a fresh VP bound to the MCP server, for the *selected
// persona*, using either its default credential or the delegated credential
// selected by Use case 4.
//
// Agent self-custody is retired: the persona's private key is held by the
// server and never exists here, so this is an API call rather than a local
// VPBuilder.sign().
import { HelixClient } from '@helixid/sdk-js';
import { callMcpTool } from '../mcpClient.js';
import { TARGET_SERVICE, USER_DID, env } from '../../config.js';
import type { Persona } from '../../personas/types.js';

export interface ProtectedResult {
  success: boolean;
  detail: string;
}

export async function callProtectedTool(
  persona: Persona,
  toolName: string,
  input: Record<string, unknown>,
): Promise<ProtectedResult> {
  const client = new HelixClient(env.helixApiUrl, { adminApiKey: env.adminApiKey });

  // With no activeCredentialId the server picks the persona's single active
  // credential itself; once Use case 4 has delegated one, the persona holds
  // more than one and the choice has to be explicit.
  const vp = await client.signVP(persona.agentDid, TARGET_SERVICE, {
    userDid: USER_DID,
    ...(persona.activeCredentialId ? { vcId: persona.activeCredentialId } : {}),
  });

  const result = await callMcpTool(toolName, { ...input, _helixVP: vp });
  // Surface the real result (success or the real rejection reason) so the model
  // can report it truthfully — the agent never writes the outcome itself.
  return { success: !result.isError, detail: result.text };
}
