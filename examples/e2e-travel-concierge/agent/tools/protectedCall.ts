// The single choke point where a verifiable presentation is created. Signs a
// fresh VP for the persona's agent DID via POST /v1/agents/:did/vp -- the
// server holds the key and signs server-side (agent self-custody is retired),
// so no private key is ever decrypted or transmitted here. That route is
// admin-gated in OSS, so this process holds the admin key.
//
// The VP is bound to the DID of the service that owns the tool, and -- when
// the agent acts for a traveler -- names that traveler. The platform then
// adds that traveler's consent grant for that service (or one a delegator up
// the chain holds); with none, it refuses to sign, which this file turns into
// a "consent required" result the UI can answer with a consent prompt.
import { HELIX_VP_META_KEY, encodeHelixVP, type SignedVP } from '@helixid/sdk-js';
import { adminCall, describeApiError } from '../../personas/platform.js';
import { callMcpTool } from '../mcpClient.js';
import { USERS, serviceForTool, type ServiceId, type UserId } from '../../config.js';
import { getService } from '../services.js';
import type { Persona } from '../../personas/types.js';

export interface ConsentPrompt {
  serviceId: ServiceId;
  serviceName: string;
  userId: UserId;
  userName: string;
  /** Every scope the service's tools need -- the consent screen offers each one. */
  scopes: string[];
}

export interface ProtectedResult {
  success: boolean;
  detail: string;
  /** Refusal code, from the platform (signing) or the service (verification/policy/scope). */
  code?: string;
  /** Where the refusal happened: the platform refusing to sign, or the service refusing the VP. */
  stage?: 'signing' | 'service';
  serviceId?: ServiceId;
  consentRequired?: ConsentPrompt;
  data?: unknown;
}

export interface CallOptions {
  /** Act on behalf of this traveler (the VP's `delegatedBy`). */
  userId?: UserId;
}

export class SigningRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function signVP(persona: Persona, serviceDid: string, userDid?: string): Promise<SignedVP> {
  const res = await adminCall<{ signedVP?: SignedVP }>(`/v1/agents/${encodeURIComponent(persona.did)}/vp`, {
    targetService: serviceDid,
    ...(userDid ? { userDid } : {}),
    // No vcId: the server presents every active credential the persona
    // holds, so a delegated one (what gives a zero-scope persona like the
    // demo's Research Agent its authority) rides along automatically.
  });
  if (!res.ok || !res.body.signedVP) {
    throw new SigningRefusedError(res.body.error?.code ?? `HTTP_${res.status}`, describeApiError(res.body.error, res.status));
  }
  return res.body.signedVP;
}

/** Sends an already-signed VP with a tool call -- the VP travels in _meta, never in the tool arguments. */
export async function presentVP(
  serviceId: ServiceId,
  toolName: string,
  input: Record<string, unknown>,
  vp: SignedVP,
): Promise<ProtectedResult> {
  const result = await callMcpTool(serviceId, toolName, input, { [HELIX_VP_META_KEY]: encodeHelixVP(vp) });
  const structured = (result.structured ?? {}) as { code?: string };
  // Surface the real result (success or the real rejection reason) so the model
  // can report it truthfully — the agent never writes the outcome itself.
  return {
    success: !result.isError,
    detail: result.text,
    serviceId,
    ...(result.isError ? { code: structured.code ?? 'REFUSED', stage: 'service' as const } : { data: result.structured }),
  };
}

async function consentPrompt(serviceId: ServiceId, userId: UserId): Promise<ConsentPrompt> {
  const service = await getService(serviceId);
  return {
    serviceId,
    serviceName: service.name,
    userId,
    userName: USERS[userId].name,
    scopes: [...new Set(service.tools.map((tool) => tool.requiredScope))],
  };
}

export async function callProtectedTool(
  persona: Persona,
  toolName: string,
  input: Record<string, unknown>,
  options: CallOptions = {},
): Promise<ProtectedResult> {
  const definition = serviceForTool(toolName);
  if (!definition) return { success: false, detail: `Unknown tool: ${toolName}`, code: 'UNKNOWN_TOOL' };
  const service = await getService(definition.id);
  const user = options.userId ? USERS[options.userId] : undefined;

  let vp: SignedVP;
  try {
    vp = await signVP(persona, service.did, user?.did);
  } catch (error) {
    if (!(error instanceof SigningRefusedError)) throw error;
    if (error.code === 'CONSENT_GRANT_NOT_FOUND' && options.userId) {
      return {
        success: false,
        stage: 'signing',
        code: 'CONSENT_REQUIRED',
        serviceId: service.id,
        detail: `Consent required: ${user?.name} has not let ${persona.displayName} (or any agent that delegated to it) use ${service.name}. HelixID refused to sign a presentation on their behalf.`,
        consentRequired: await consentPrompt(service.id, options.userId),
      };
    }
    return {
      success: false,
      stage: 'signing',
      code: error.code,
      serviceId: service.id,
      detail: `Refused by HelixID while signing the presentation [${error.code}]: ${error.message}`,
    };
  }

  const result = await presentVP(service.id, toolName, input, vp);
  if (!result.success && result.code === 'CONSENT_REQUIRED' && options.userId) {
    result.consentRequired = await consentPrompt(service.id, options.userId);
  }
  return result;
}
