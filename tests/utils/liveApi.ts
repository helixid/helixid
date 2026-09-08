import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { expect } from 'vitest';
import { HelixClient } from '@helixid/sdk-js';
import type { SignedVC, SignedVP } from '@helixid/sdk-js';
import { createTestPrisma } from './prisma.js';

export const LIVE_HEDERA_TIMEOUT_MS = 240_000;

/**
 * Matches tests/setup.ts's fallback for the non-live suite: HELIX_SIGNING_KEY
 * only needs to be a well-formed Ed25519 key for these tests (it signs VCs
 * issued during the run, nothing production-sensitive), so live tests must
 * not depend on a real secret being configured in CI — same reasoning as
 * resolveLiveDidMethod defaulting to 'key' below, and consistent with the
 * "no Hedera network access or secrets are needed at all" comment on the
 * Live tests steps in ci.yml. A CI secret left unset resolves to an empty
 * string (not undefined), so this is checked explicitly rather than via `??`.
 */
const DEFAULT_TEST_SIGNING_KEY = 'a'.repeat(64);

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value !== '');
}

export interface LiveApi {
  baseUrl: string;
  adminApiKey: string;
  issuerDid: string | undefined;
  stop(): Promise<void>;
}

export interface LiveAgent {
  did: string;
  vcId: string;
  /**
   * Retained as a no-op so callers keep their teardown shape. Server custody
   * creates nothing locally — no wallet file, no temp dir — so there is
   * genuinely nothing to remove.
   */
  cleanup(): Promise<void>;
}

/**
 * Postgres is the default and only storage adapter these live tests have
 * ever driven — set LIVE_STORAGE_ADAPTER=sqlite to run the same suite
 * against helix-api's other real, first-class storage backend instead
 * (see server.ts: HELIX_STORAGE_ADAPTER defaults to 'sqlite'). Each
 * startLiveApi() call gets its own fresh sqlite file when this is set, so
 * there's nothing to reset between runs — no prisma, no Postgres, no
 * network required. Postgres-mode behavior is untouched.
 */
function usingSqliteAdapter(): boolean {
  return process.env['LIVE_STORAGE_ADAPTER'] === 'sqlite';
}

export async function resetLiveTestDatabase(): Promise<void> {
  if (usingSqliteAdapter()) return;
  assertTestDatabaseUrl(process.env['DATABASE_URL']);
  const prisma = createTestPrisma();
  await prisma.auditLog.deleteMany();
  await prisma.vc.deleteMany();
  await prisma.statusListEntry.deleteMany();
  await prisma.vpId.deleteMany();
  await prisma.challenge.deleteMany();
  await prisma.enrollmentToken.deleteMany();
  await prisma.serviceRegistry.deleteMany();
  await prisma.didUpdate.deleteMany();
  await prisma.did.deleteMany();
  await prisma.$disconnect();
}

/**
 * Which DID method newly-onboarded agents (and, unless overridden, the
 * issuer) use for this run — independent of storage adapter. Set
 * LIVE_DID_METHOD=web to exercise the did:web path instead. Defaults to
 * 'key': self-describing, zero network/registry dependency, same reasoning
 * as usingSqliteAdapter() above. 'hedera' is intentionally not a supported
 * value here — see the DID_METHOD/MockHederaClient gap documented in
 * DIDService.createDID and this repo's PR history; live tests need a real
 * did:hedera-resolvable identity, which this harness cannot fabricate.
 */
function resolveLiveDidMethod(apiEnv: Record<string, string>, workspaceEnv: Record<string, string>): 'key' | 'web' {
  const configured = apiEnv['DID_METHOD'] ?? workspaceEnv['DID_METHOD'] ?? process.env['LIVE_DID_METHOD'];
  return configured === 'web' ? 'web' : 'key';
}

export async function startLiveApi(): Promise<LiveApi> {
  const port = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const apiRoot = fileURLToPath(new URL('../..', import.meta.url));
  const workspaceEnv = readEnvFile(`${apiRoot}/../.env`);
  const apiEnv = readEnvFile(`${apiRoot}/.env`);
  const testEnv = readEnvFile(`${apiRoot}/.env.test`);
  const adminApiKey =
    apiEnv['HELIX_ADMIN_API_KEY'] ?? workspaceEnv['HELIX_ADMIN_API_KEY'] ?? process.env['HELIX_ADMIN_API_KEY'] ?? 'test-admin-key-0001';
  // tests/setup.ts (loaded for every non-live test file via vitest's
  // setupFiles) unconditionally defaults DID_METHOD to 'hedera' with a mocked
  // Hedera client, on *this* process — and that leaks into the spawned
  // server's env below via the `...process.env` spread if left unhandled.
  // Live tests never want that default (see resolveLiveDidMethod above).
  const didMethod = resolveLiveDidMethod(apiEnv, workspaceEnv);
  // did:web resolves by fetching back from DID_DOMAIN, so it must match this
  // run's actual bound port — a static configured value can't, since a fresh
  // port is chosen per startLiveApi() call. did:key needs no domain at all.
  const didDomain =
    didMethod === 'web'
      ? apiEnv['DID_DOMAIN'] ?? workspaceEnv['DID_DOMAIN'] ?? `127.0.0.1:${port}`
      : apiEnv['DID_DOMAIN'] ?? workspaceEnv['DID_DOMAIN'] ?? process.env['DID_DOMAIN'];
  // Both did:key and did:web issuer DIDs auto-derive server-side from
  // HELIX_SIGNING_KEY/DID_DOMAIN when unset (see loadConfig()) — only pass
  // one through if a file explicitly configured it. The actual resolved
  // value (needed for assertions) is read back from /health below instead
  // of duplicated here.
  const configuredIssuerDid = apiEnv['HELIX_ISSUER_DID'] ?? workspaceEnv['HELIX_ISSUER_DID'];

  const sqliteMode = usingSqliteAdapter();
  let sqliteDir: string | undefined;
  let sqlitePath: string | undefined;
  let databaseUrl: string | undefined;
  if (sqliteMode) {
    sqliteDir = await mkdtemp(join(tmpdir(), 'helix-live-sqlite-'));
    sqlitePath = join(sqliteDir, 'live.sqlite');
  } else {
    databaseUrl = testEnv['DATABASE_URL'] ?? process.env['DATABASE_URL'];
    assertTestDatabaseUrl(databaseUrl);
  }

  const env = {
    ...process.env,
    ...(sqliteMode
      ? { HELIX_STORAGE_ADAPTER: 'sqlite', HELIX_SQLITE_PATH: sqlitePath }
      : { DATABASE_URL: databaseUrl }),
    HEDERA_NETWORK: apiEnv['HEDERA_NETWORK'] ?? workspaceEnv['HEDERA_NETWORK'] ?? process.env['HEDERA_NETWORK'],
    HEDERA_OPERATOR_ID: apiEnv['HEDERA_OPERATOR_ID'] ?? workspaceEnv['HEDERA_OPERATOR_ID'] ?? process.env['HEDERA_OPERATOR_ID'],
    HEDERA_OPERATOR_KEY: apiEnv['HEDERA_OPERATOR_KEY'] ?? workspaceEnv['HEDERA_OPERATOR_KEY'] ?? process.env['HEDERA_OPERATOR_KEY'],
    HEDERA_TOPIC_ID: apiEnv['HEDERA_TOPIC_ID'] ?? workspaceEnv['HEDERA_TOPIC_ID'] ?? process.env['HEDERA_TOPIC_ID'],
    HELIX_SIGNING_KEY: firstNonEmpty(
      apiEnv['HELIX_SIGNING_KEY'],
      workspaceEnv['HELIX_SIGNING_KEY'],
      process.env['HELIX_SIGNING_KEY'],
    ) ?? DEFAULT_TEST_SIGNING_KEY,
    HELIX_ISSUER_DID: configuredIssuerDid,
    DID_METHOD: didMethod,
    DID_DOMAIN: didDomain,
    JWT_SESSION_TTL_SECONDS: apiEnv['JWT_SESSION_TTL_SECONDS'] ?? workspaceEnv['JWT_SESSION_TTL_SECONDS'] ?? process.env['JWT_SESSION_TTL_SECONDS'] ?? '600',
    HELIX_ADMIN_API_KEY: adminApiKey,
    NODE_ENV: 'test',
    PORT: String(port),
    API_BASE_URL: baseUrl,
  };

  const child = spawn('pnpm', ['--config.engine-strict=false', 'exec', 'tsx', 'src/server.ts'], {
    cwd: apiRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let logs = '';
  const appendLogs = (chunk: Buffer) => {
    logs += chunk.toString();
    logs = logs.slice(-8000);
  };
  child.stdout.on('data', appendLogs);
  child.stderr.on('data', appendLogs);

  await waitForHealth(baseUrl, child, () => logs);
  // The actual resolved issuer DID — read back rather than recomputed here,
  // since did:key/did:web auto-derive it server-side (loadConfig()) when not
  // explicitly configured.
  const health = (await (await fetch(`${baseUrl}/health`)).json()) as { issuerDid?: string };

  return {
    baseUrl,
    adminApiKey,
    issuerDid: health.issuerDid,
    async stop() {
      await stopChild(child);
      if (sqliteDir) await rm(sqliteDir, { recursive: true, force: true });
    },
  };
}

export async function onboardLiveAgent(
  api: LiveApi,
  client: HelixClient,
  options: {
    agentName: string;
    requestedScopes: string[];
    requestedDomains: string[];
    maxDelegationDepth?: number;
  },
): Promise<LiveAgent> {
  const tokenRes = await fetch(`${api.baseUrl}/v1/enrollment-tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agentName: options.agentName,
      requestedScopes: options.requestedScopes,
      requestedDomains: options.requestedDomains,
      ...(options.maxDelegationDepth === undefined ? {} : { maxDelegationDepth: options.maxDelegationDepth }),
    }),
  });
  expect(tokenRes.status).toBe(201);
  const { token } = (await tokenRes.json()) as { token: string };

  // Server custody: the API generates and holds the agent's key. Nothing
  // local is created, so there is nothing to clean up either.
  const { agentDid, vcId } = await client.onboardAgent(token, options.requestedDomains);

  return { did: agentDid, vcId, cleanup: async () => {} };
}

/**
 * Asks the API to sign a VP on a server-custody agent's behalf.
 *
 * Replaces the old local VPBuilder path: with agent self-custody retired the
 * caller never has the agent's key, so signing is an API call. The server
 * looks up the agent's own authority VC itself — only a consent grant, which
 * is not secret material, is passed in.
 */
export async function signVPForAgent(
  client: HelixClient,
  agentDid: string,
  options: { targetService: string; userDid?: string; grantVC?: SignedVC; vcId?: string },
): Promise<SignedVP> {
  return client.signVP(agentDid, options.targetService, {
    ...(options.userDid !== undefined ? { userDid: options.userDid } : {}),
    ...(options.grantVC !== undefined ? { grantVC: options.grantVC } : {}),
    ...(options.vcId !== undefined ? { vcId: options.vcId } : {}),
  });
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate test port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function assertTestDatabaseUrl(databaseUrl: string | undefined): void {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for live integration tests');
  }
  let dbName = '';
  try {
    dbName = new URL(databaseUrl).pathname.replace(/^\//, '');
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to reset non-test database '${dbName}'. Use helix-api/.env.test for live integration tests.`);
  }
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    values[key] = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
  }
  return values;
}

async function waitForHealth(
  baseUrl: string,
  child: ChildProcess,
  getLogs: () => string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`API server exited before becoming ready:\n${getLogs()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Keep polling until the child has bound the socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for API server:\n${getLogs()}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const timeout = new Promise<void>((resolve) => {
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
      resolve();
    }, 3000);
  });
  await Promise.race([exited, timeout]);
}
