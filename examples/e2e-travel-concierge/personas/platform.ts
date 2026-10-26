// The one place this app talks to the self-hosted HelixID API's admin
// surface. In OSS every privileged route (onboarding tokens, signing a VP for
// a server-held agent key, delegation, revocation, service enrollment and
// consent grants) is gated by the single admin key -- there are no accounts.
// The browser never sees this key; only the agent and MCP server processes
// hold it.
import { env } from '../config.js';

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  body: T & { error?: { code?: string; message?: string } };
}

/**
 * fetch() that waits out the API's rate limit instead of failing: running
 * several scenarios back to back can burst past a per-minute cap. Honours
 * Retry-After (or the "retry in N seconds" message), up to twice.
 */
export async function patientFetch(url: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt >= 2) return res;
    const header = Number(res.headers.get('retry-after'));
    const text = await res.clone().text().catch(() => '');
    const fromMessage = Number(/retry in (\d+)/.exec(text)?.[1]);
    const waitSeconds = Math.min(65, Math.max(1, header || fromMessage || 5));
    console.warn(`[HelixID] rate limited on ${new URL(url).pathname}; retrying in ${waitSeconds}s`);
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
  }
}

/** One admin-authenticated call. Never throws on a 4xx -- refusals are data here. */
export async function adminCall<T>(path: string, body?: unknown, method: 'GET' | 'POST' = 'POST'): Promise<ApiResult<T>> {
  const res = await patientFetch(`${env.helixApiUrl}${path}`, {
    method,
    headers: {
      'x-admin-api-key': env.adminApiKey,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = (await res.json().catch(() => ({}))) as ApiResult<T>['body'];
  return { ok: res.ok, status: res.status, body: parsed };
}

export function describeApiError(error: { code?: string; message?: string } | undefined, status: number): string {
  return error?.message ?? `HTTP ${status}`;
}
