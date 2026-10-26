// Deliberately misbehaving agent actions for the attack scenarios. Each one
// starts from a genuine, platform-signed VP and then does what a compromised
// agent or a network attacker would: send it twice, edit it, or present it to
// a service it wasn't made for. None of this can make HelixID accept it --
// that's the point of the scenario.
import { randomUUID } from 'node:crypto';
import type { SignedVC, SignedVP } from '@helixid/sdk-js';
import { serviceForTool, type ServiceId } from '../config.js';
import type { Persona } from '../personas/types.js';
import { getService } from './services.js';
import { presentVP, signVP, SigningRefusedError, type ProtectedResult } from './tools/protectedCall.js';

interface Capture {
  serviceId: ServiceId;
  toolName: string;
  input: Record<string, unknown>;
  vp: SignedVP;
}

// Captured VPs live only in this process's memory, and only for the demo.
const captures = new Map<string, Capture>();

function refusedWhileSigning(error: unknown): ProtectedResult {
  if (error instanceof SigningRefusedError) {
    return { success: false, stage: 'signing', code: error.code, detail: `Refused by HelixID while signing [${error.code}]: ${error.message}` };
  }
  throw error;
}

/** Signs one VP, uses it once (legitimately), and keeps a copy -- as an eavesdropper would. */
export async function captureAndSend(
  persona: Persona,
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ captureId?: string; vpId?: string; result: ProtectedResult }> {
  const definition = serviceForTool(toolName);
  if (!definition) return { result: { success: false, code: 'UNKNOWN_TOOL', detail: `Unknown tool: ${toolName}` } };
  const service = await getService(definition.id);
  let vp: SignedVP;
  try {
    vp = await signVP(persona, service.did);
  } catch (error) {
    return { result: refusedWhileSigning(error) };
  }
  const captureId = randomUUID();
  captures.set(captureId, { serviceId: service.id, toolName, input, vp });
  return { captureId, vpId: vp.id, result: await presentVP(service.id, toolName, input, vp) };
}

/** Presents a previously captured VP again, byte for byte. */
export async function replay(captureId: string): Promise<ProtectedResult> {
  const capture = captures.get(captureId);
  if (!capture) return { success: false, code: 'UNKNOWN_CAPTURE', detail: 'No captured presentation with that id (the agent process may have restarted).' };
  return presentVP(capture.serviceId, capture.toolName, capture.input, capture.vp);
}

/**
 * Signs a genuine VP, then edits the agent credential inside it to claim
 * extra scopes -- what an agent trying to promote itself would do. The
 * issuer's signature over the credential no longer matches.
 */
export async function tamperAndSend(
  persona: Persona,
  toolName: string,
  input: Record<string, unknown>,
  addScopes: string[],
): Promise<ProtectedResult & { tamperedVcId?: string }> {
  const definition = serviceForTool(toolName);
  if (!definition) return { success: false, code: 'UNKNOWN_TOOL', detail: `Unknown tool: ${toolName}` };
  const service = await getService(definition.id);
  let vp: SignedVP;
  try {
    vp = await signVP(persona, service.did);
  } catch (error) {
    return refusedWhileSigning(error);
  }
  const tampered = structuredClone(vp) as SignedVP;
  const agentVC = (tampered.verifiableCredential as SignedVC[]).find((vc) =>
    (vc.type as string[]).includes('HelixAgentCredential'),
  ) as (SignedVC & { credentialSubject: { privilegeScopes: string[] } }) | undefined;
  if (!agentVC) return { success: false, code: 'NO_AGENT_VC', detail: 'The VP carried no agent credential to tamper with.' };
  agentVC.credentialSubject.privilegeScopes = [...new Set([...agentVC.credentialSubject.privilegeScopes, ...addScopes])];
  return { ...(await presentVP(service.id, toolName, input, tampered)), tamperedVcId: agentVC.id };
}

/**
 * Signs a genuine VP for one service and presents it to another -- e.g. a
 * malicious Helix Stay forwarding a VP it received to Helix Air. The VP's
 * `targetService` names the service it was made for.
 */
export async function presentToWrongService(
  persona: Persona,
  signForServiceId: ServiceId,
  toolName: string,
  input: Record<string, unknown>,
): Promise<ProtectedResult> {
  const definition = serviceForTool(toolName);
  if (!definition) return { success: false, code: 'UNKNOWN_TOOL', detail: `Unknown tool: ${toolName}` };
  const signedFor = await getService(signForServiceId);
  let vp: SignedVP;
  try {
    vp = await signVP(persona, signedFor.did);
  } catch (error) {
    return refusedWhileSigning(error);
  }
  return presentVP(definition.id, toolName, input, vp);
}
