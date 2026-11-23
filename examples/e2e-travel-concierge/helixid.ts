// The two kinds of call this example makes to HelixID: admin calls (the
// organization's operator credential, which creates agents and the service,
// issues root hops and revokes) and DID-document fetches. Refusals keep their
// code so the demo can show them.
import { env } from './config.js';

export class HelixError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function admin<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${env.helixApiUrl}${path}`, {
    method,
    headers: { 'x-admin-api-key': env.adminApiKey, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = (await res.json().catch(() => ({}))) as T & { error?: { code?: string; message?: string } };
  if (!res.ok) {
    throw new HelixError(parsed.error?.code ?? `HTTP_${res.status}`, res.status, parsed.error?.message ?? `${method} ${path} failed: HTTP ${res.status}`);
  }
  return parsed;
}

/**
 * Fetch for DID documents, cards and status lists. HelixID serves them on
 * HELIX_API_URL; a did:web names them over https, so on a local or compose
 * network (http) the https URL of HelixID's own host is fetched over http.
 */
const helixHost = new URL(env.helixApiUrl).host;
export function helixFetch(url: string): Promise<Response> {
  const local = url.replace(new RegExp(`^https://${helixHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[/?#]|$)`), `http://${helixHost}`);
  return fetch(local);
}
