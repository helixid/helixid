// The agent's consent-aware tool call — the whole of Part D's behaviour in one
// function.
//
// The agent itself has no consent logic: it never decides what the user may
// authorize, it only notices when an SP says "not without a grant" and hands
// off to that SP's own consent page. What makes step 5 of the demo work is the
// first line of callSpTool(): before building any presentation, ask whether a
// grant for THIS (service, user) pair already exists. If it does, it travels
// in the VP and the SP is satisfied on the first attempt — no prompt, no
// second grant issued.
//
// Agent self-custody is retired, so "ask" now means asking the platform
// rather than a local wallet: the SP's grant is persisted when it finalizes
// it, and the VP is signed by the API on the agent's behalf.

import type { HelixClient, SignedVC, SignedVP } from '@helixid/sdk-js';

export interface ConsentPrompt {
  serviceDid: string;
  consentUrl: string;
  requiredScope: string;
}

/**
 * Surfaces consent to the End User and returns the grant the SP issued, or
 * null if the user declined. In the browser demo this opens the SP's consent
 * page; in tests it drives the same two HTTP routes directly.
 */
export type ConsentHandler = (prompt: ConsentPrompt) => Promise<SignedVC | null>;

export interface CallSpToolOptions {
  client: HelixClient;
  /** The agent's own DID — what the wallet file used to imply. */
  agentDid: string;
  /** DID or email — must be the identifier the grant captured at consent time. */
  userDid: string;
  spMcpUrl: string;
  serviceDid: string;
  toolName: string;
  args?: Record<string, unknown>;
  onConsentRequired: ConsentHandler;
  /**
   * Stitches every audit event this call produces — presentation,
   * verification, authorization, invocation, and any grant issued along the
   * way — into one traceable chain for a single user action.
   */
  correlationId?: string;
}

export interface CallSpToolResult {
  ok: boolean;
  data?: Record<string, unknown>;
  /** True when this call had to stop and ask the user to authorize. */
  consentPrompted: boolean;
  error?: { code: string; reason?: string; message: string };
}

export class ConsentDeclinedError extends Error {
  constructor(serviceDid: string) {
    super(`User declined consent for ${serviceDid}`);
    this.name = 'ConsentDeclinedError';
  }
}

interface JsonRpcResponse {
  result?: { structuredContent?: Record<string, unknown> };
  error?: {
    code?: number;
    message?: string;
    data?: { code?: string; reason?: string; requiredScope?: string; consentUrl?: string };
  };
}

/**
 * The platform's standing grant for this SP and this user, if any.
 *
 * There is no wallet to ask any more: the SP's DelegationGrantCredential is
 * persisted by the platform when the SP finalizes it. listVCs() returns
 * summaries without a credentialSubject, so each active credential is read
 * back in full to match on (service, user). That is a read per credential,
 * which is fine at demo scale — an agent holding many grants would want a
 * server-side filter instead.
 */
async function findExistingGrant(
  client: HelixClient,
  agentDid: string,
  serviceDid: string,
  userDid: string,
): Promise<SignedVC | undefined> {
  const summaries = await client.listVCs({ subjectDid: agentDid, status: 'active' });
  for (const summary of summaries) {
    const vc = (await client.getVC(summary.vcId)).vc as SignedVC | undefined;
    if (!vc || !(vc.type as string[]).includes('DelegationGrantCredential')) continue;
    const subject = vc.credentialSubject as unknown as {
      userDid?: string;
      serviceDid?: string;
    };
    // serviceDid is optional on the grant subject; the issuer is the SP either way.
    if (subject.userDid === userDid && (subject.serviceDid ?? vc.issuer) === serviceDid) {
      return vc;
    }
  }
  return undefined;
}

async function buildVP(
  client: HelixClient,
  agentDid: string,
  serviceDid: string,
  userDid: string,
  grant: SignedVC | undefined,
): Promise<SignedVP> {
  // Signed by the API on the agent's behalf — with self-custody retired the
  // agent has no key to sign with. The server looks up the agent's own
  // HelixAgentCredential itself; the grant travels as a separate, independent
  // credential and is never merged into that credential's delegation chain.
  return client.signVP(agentDid, serviceDid, {
    userDid,
    ...(grant ? { grantVC: grant } : {}),
  });
}

async function postToolCall(
  spMcpUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  vp: SignedVP,
  correlationId?: string,
): Promise<JsonRpcResponse> {
  const response = await fetch(spMcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: {
          ...args,
          _helixVP: vp,
          ...(correlationId !== undefined ? { _helixCorrelationId: correlationId } : {}),
        },
      },
    }),
  });
  return (await response.json()) as JsonRpcResponse;
}

export async function callSpTool(options: CallSpToolOptions): Promise<CallSpToolResult> {
  const { client, agentDid, userDid, spMcpUrl, serviceDid, toolName } = options;
  const args = options.args ?? {};

  // Step 5 hinges on this: reuse a standing grant if the platform already
  // holds one for this (service, user) pair.
  const existingGrant = await findExistingGrant(client, agentDid, serviceDid, userDid);
  const first = await postToolCall(
    spMcpUrl,
    toolName,
    args,
    await buildVP(client, agentDid, serviceDid, userDid, existingGrant),
    options.correlationId,
  );

  if (!first.error) {
    return { ok: true, consentPrompted: false, ...(first.result?.structuredContent !== undefined ? { data: first.result.structuredContent } : {}) };
  }

  if (first.error.data?.code !== 'CONSENT_REQUIRED') {
    return {
      ok: false,
      consentPrompted: false,
      error: {
        code: first.error.data?.code ?? 'CALL_FAILED',
        ...(first.error.data?.reason !== undefined ? { reason: first.error.data.reason } : {}),
        message: first.error.message ?? 'Tool call failed',
      },
    };
  }

  // The SP wants a grant. Hand off to its consent page.
  const grantVC = await options.onConsentRequired({
    serviceDid,
    consentUrl: first.error.data.consentUrl ?? '',
    requiredScope: first.error.data.requiredScope ?? '',
  });
  if (!grantVC) {
    throw new ConsentDeclinedError(serviceDid);
  }

  // No agent-side store to put it in, and none needed: the platform recorded
  // this grant when the SP finalized it, so the next call's findExistingGrant()
  // will see it. Passed straight through here to avoid re-reading it.
  const retry = await postToolCall(
    spMcpUrl,
    toolName,
    args,
    await buildVP(client, agentDid, serviceDid, userDid, grantVC),
    options.correlationId,
  );

  if (retry.error) {
    return {
      ok: false,
      consentPrompted: true,
      error: {
        code: retry.error.data?.code ?? 'CALL_FAILED',
        ...(retry.error.data?.reason !== undefined ? { reason: retry.error.data.reason } : {}),
        message: retry.error.message ?? 'Tool call failed after consent',
      },
    };
  }

  return {
    ok: true,
    consentPrompted: true,
    ...(retry.result?.structuredContent !== undefined ? { data: retry.result.structuredContent } : {}),
  };
}
