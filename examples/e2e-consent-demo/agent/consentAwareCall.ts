// The agent's consent-aware tool call (KYA-OS stories C-C, L3-E, L3-H).
//
// Every call carries a request proof signed by the agent's own key (self
// custody: the key helix init generated, never sent to Helix) and, once the user consented
// at this SP, its chain: the root hop the user's did:key signed on Helix's
// consent page, renewed without a click before it expires. When the SP answers
// with the signed needs_authorization challenge, the agent first checks the
// SP's response proof (so the consent URL it shows is the one the SP sent),
// then hands the user the URL and waits; once the user approved, it retries
// with the resume token and the new hop.
//
// Step 4 of the demo (a second booking at the same SP, no prompt) is the
// stored hop: the SP verifies it on the first attempt.

import { kyaos } from '@helixid/sdk-js';
import type { ConsentStore } from './consentStore.js';

/** Which of the SP's users the agent acts for (see helixid-config DEMO_SERVICE_USER). */
export const SERVICE_USER_META_KEY = 'org.helixid/service-user';

export interface CallSpToolOptions {
  signer: kyaos.Signer;
  agentDid: string;
  consents: ConsentStore;
  serviceUserId: string;
  spMcpUrl: string;
  serviceDid: string;
  toolName: string;
  args?: Record<string, unknown>;
  correlationId?: string;
  /** Resolves the SP's did:web document, to check its response proofs. */
  resolveDid: kyaos.DidResolver;
}

export interface ConsentPrompt {
  authorizationUrl: string;
  resumeToken: string;
  scopes: string[];
}

export type CallSpToolResult =
  | { status: 'ok'; data?: Record<string, unknown>; consentReused: boolean }
  | { status: 'consent_required'; prompt: ConsentPrompt }
  | { status: 'error'; error: { code: string; message: string } };

interface JsonRpcResponse {
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: { code?: string } };
}

async function post(spMcpUrl: string, call: { method: string; params: Record<string, unknown> }): Promise<JsonRpcResponse> {
  const response = await fetch(spMcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...call }),
  });
  return (await response.json()) as JsonRpcResponse;
}

/** The stored consent's hop, renewed first when it nears its end inside the consented window. */
async function currentHop(options: CallSpToolOptions): Promise<kyaos.consent.ConsentHop | undefined> {
  const stored = await options.consents.get(options.serviceDid);
  if (stored === undefined) return undefined;
  const now = Date.now();
  // renewBefore never answers a time before `now`, so it is asked from the epoch: when the 60 s margin starts.
  const renewAt = kyaos.consent.renewBefore(stored.hop['validUntil'] as string, 60, 0);
  if (now < renewAt) return stored.hop;
  if (now >= stored.windowUntil * 1000) {
    // The consented window is over: the user is asked again on the next call.
    await options.consents.drop(options.serviceDid);
    return undefined;
  }
  try {
    const renewed = await kyaos.consent.renewConsentHop({ helixUrl: stored.helixUrl, consentId: stored.consentId, signer: options.signer, serviceDid: options.serviceDid });
    await options.consents.put({ ...stored, hop: renewed.hop, windowUntil: renewed.windowUntil });
    return renewed.hop;
  } catch {
    // Withdrawn, or the window ended: ask again.
    await options.consents.drop(options.serviceDid);
    return undefined;
  }
}

/** The call as sent: arguments (with the resume control arguments on a retry), the proof over exactly that, and the chain. */
async function signedCall(options: CallSpToolOptions, hop: kyaos.consent.ConsentHop | undefined, resume?: { token: string; hop: unknown }): Promise<kyaos.ProofRequest> {
  const base = {
    name: options.toolName,
    arguments: { ...(options.args ?? {}), ...(options.correlationId !== undefined ? { _helixCorrelationId: options.correlationId } : {}) },
  };
  const params = resume === undefined ? base : kyaos.withResume(base, resume.token, resume.hop);
  const call = { method: 'tools/call', params: { ...params, _meta: { [SERVICE_USER_META_KEY]: options.serviceUserId } } };
  return kyaos.withRequestProof(call, options.signer, { audience: options.serviceDid, ...(hop === undefined ? {} : { chain: [hop] }) });
}

function outcome(response: JsonRpcResponse, consentReused: boolean): CallSpToolResult {
  if (response.error) return { status: 'error', error: { code: response.error.data?.code ?? 'CALL_FAILED', message: response.error.message ?? 'Tool call failed' } };
  const result = response.result ?? {};
  if (result['isError']) {
    const code = (result['structuredContent'] as { error?: string } | undefined)?.error ?? 'CALL_FAILED';
    return { status: 'error', error: { code, message: (result['content'] as { text?: string }[] | undefined)?.[0]?.text ?? code } };
  }
  return { status: 'ok', consentReused, ...(result['structuredContent'] !== undefined ? { data: result['structuredContent'] as Record<string, unknown> } : {}) };
}

export async function callSpTool(options: CallSpToolOptions): Promise<CallSpToolResult> {
  const hop = await currentHop(options);
  const call = await signedCall(options, hop);
  const response = await post(options.spMcpUrl, call as { method: string; params: Record<string, unknown> });
  if (response.result && kyaos.isNeedsAuthorization(response.result)) {
    // The SP's signature over the challenge, checked before its URL is trusted.
    const { challenge } = await kyaos.handleNeedsAuthorization(response.result, options.serviceDid, options.resolveDid, { request: call as { method: string; params: Record<string, unknown> } });
    return { status: 'consent_required', prompt: { authorizationUrl: challenge.authorizationUrl, resumeToken: challenge.resumeToken, scopes: challenge.scopes } };
  }
  return outcome(response, hop !== undefined);
}

/**
 * After the user decided on Helix's page: waits for the root hop, keeps it,
 * and retries the challenged call with the resume token and the hop. Throws
 * ConsentFlowError (reason `consent_not_approved`) when the user declined.
 */
export async function completeConsent(options: CallSpToolOptions, prompt: ConsentPrompt): Promise<CallSpToolResult> {
  const approved = await kyaos.consent.awaitConsentHop(prompt.authorizationUrl, { agentDid: options.agentDid, serviceDid: options.serviceDid, timeoutMs: 300_000 });
  await options.consents.put({ serviceDid: options.serviceDid, consentId: approved.consentId, hop: approved.hop, windowUntil: approved.windowUntil, helixUrl: approved.helixUrl });
  const call = await signedCall(options, approved.hop, { token: prompt.resumeToken, hop: approved.hop });
  return outcome(await post(options.spMcpUrl, call as { method: string; params: Record<string, unknown> }), false);
}
