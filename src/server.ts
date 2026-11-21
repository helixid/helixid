// Copyright 2026 DgVerse LLP
// Licensed under the Apache License, Version 2.0
//
// The self-hosted HelixID server. Every route/service/repository is
// imported from @helixid/core — this file is only the composition root:
// wire config -> storage -> services -> routes, register the single
// admin-key auth gate, listen. No hosted-account/multi-tenant code exists
// here at all (contrast with the closed-source enterprise server, which
// imports this exact same @helixid/core and layers accounts/quotas on top
// rather than forking it).
import './loadEnv.js';
import crypto from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import pg from 'pg';
import { Redis } from 'ioredis';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import {
  AesGcmKeyCustody,
  AgentRepository,
  agentRoutes,
  AgentService,
  auditLogRoutes,
  auditRoutes,
  buildDIDDocument,
  createApiAudit,
  createApiAuditStorage,
  createDidCache,
  createHederaClient,
  createStatusListCache,
  derivePublicKey,
  DidKeyRepository,
  DidRepository,
  didRoutes,
  DIDService,
  didWebRoutes,
  errorHandler,
  extractEd25519PublicKeyHexFromDIDDocument,
  generateKeyPair,
  loadConfigFromEnv,
  resolveDidMethod,
  serviceProviderRoutes,
  ServiceProviderService,
  ServiceRepository,
  sessionRoutes,
  SqliteStore,
  statusListRoutes,
  VcRepository,
  vcRoutes,
  VCService,
  vpRoutes,
  VPService,
  type DIDDocument,
  type RedisLike,
} from '@helixid/core';

const config = loadConfigFromEnv();
const storageAdapter =
  (config as unknown as { HELIX_STORAGE_ADAPTER?: 'sqlite' | 'postgres' }).HELIX_STORAGE_ADAPTER ??
  'postgres';
const cacheAdapter =
  (config as unknown as { HELIX_CACHE_ADAPTER?: 'memory' | 'redis' }).HELIX_CACHE_ADAPTER ??
  'memory';
const usingPostgres = storageAdapter === 'postgres';
const usingSqlite = storageAdapter === 'sqlite';
const apiPackageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configuredSqlitePath =
  (config as unknown as { HELIX_SQLITE_PATH?: string }).HELIX_SQLITE_PATH ?? 'data/helixid.sqlite';
const sqlitePath = isAbsolute(configuredSqlitePath)
  ? configuredSqlitePath
  : resolve(apiPackageDir, configuredSqlitePath);
const databaseName = getDatabaseName(config.DATABASE_URL);

if (usingPostgres && config.NODE_ENV !== 'test' && /test/i.test(databaseName)) {
  throw new Error(
    `Refusing to start ${config.NODE_ENV} API against test database '${databaseName}'. ` +
      'Set DATABASE_URL to the working database or run with NODE_ENV=test intentionally.',
  );
}

const pool = usingPostgres ? new pg.Pool({ connectionString: config.DATABASE_URL }) : null;
const adapter = pool ? new PrismaPg(pool) : null;
const prisma = adapter ? new PrismaClient({ adapter }) : undefined;
const sqlite = usingSqlite ? new SqliteStore(sqlitePath) : undefined;

const redis: RedisLike | null =
  cacheAdapter === 'redis' && config.CACHE_L2_ENABLED && config.REDIS_URL
    ? new Redis(config.REDIS_URL)
    : null;

// A-2: every audit event enters through the authoritative recorder.
const auditDeps = { pool, sqlite };
const audit = createApiAudit(config, createApiAuditStorage(auditDeps), { deps: auditDeps, baseDir: apiPackageDir });
// Opens every known ledger: a journal behind the restore witness, or a new
// recorder key, opens a successor epoch here, before any request is served.
await audit.recorder.start();
const auditTrail = audit.trail;
const didRepository = new DidRepository(prisma, sqlite);
const vcRepository = new VcRepository(prisma, sqlite);
const agentRepository = new AgentRepository(prisma, sqlite);
const didKeyRepository = new DidKeyRepository(prisma, sqlite);
const serviceRepository = new ServiceRepository(prisma, sqlite);

await ensureIssuerDidCached();

const didMethod = resolveDidMethod(process.env);
const hederaClient = await createHederaClient(config);
const didCache = createDidCache<DIDDocument>(config, redis);
const statusListCache = createStatusListCache<string>(config, redis);
const jwtSessionKeyPair = generateKeyPair();

const didService = new DIDService(
  didRepository,
  hederaClient,
  auditTrail,
  didCache,
  config.DID_CACHE_L1_TTL_SECONDS,
  didMethod,
  config.DID_DOMAIN,
);
const vcService = new VCService(
  vcRepository,
  didService,
  auditTrail,
  config.HELIX_SIGNING_KEY,
  config.HELIX_ISSUER_DID,
  config.API_BASE_URL,
  statusListCache,
  config.STATUS_LIST_CACHE_L1_TTL_SECONDS,
);
const vpService = new VPService(vcService, auditTrail, config.API_BASE_URL, {
  signingKey: jwtSessionKeyPair.privateKey,
  issuerDid: config.HELIX_ISSUER_DID,
  ttlSeconds: config.JWT_SESSION_TTL_SECONDS,
});
// Agent self-custody has been retired — every agent's private key is now
// generated and held here, encrypted with this one shared master key. Unset
// in dev falls back to a random per-process key (fine for local dev; means
// encrypted DidKey rows don't survive a restart in that mode) — same
// pattern as HOSTED_ACCESS_TOKEN_SECRET below it.
const agentKeyEncryptionKey = config.HOSTED_KEY_ENCRYPTION_KEY ?? crypto.randomBytes(32).toString('hex');
const keyCustody = new AesGcmKeyCustody(agentKeyEncryptionKey);
const agentService = new AgentService(
  agentRepository,
  didService,
  vcService,
  auditTrail,
  didKeyRepository,
  keyCustody,
);

// Services are custodial too: same master key and custody object as agents.
const serviceProviderService = new ServiceProviderService(
  didService,
  vcService,
  serviceRepository,
  didKeyRepository,
  keyCustody,
  auditTrail,
);

const app = Fastify({
  logger: {
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    redact: ['req.headers.authorization', 'req.body.privateKey', 'req.body.privateKeyHex'],
  },
  genReqId: () => `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
});

app.addSchema({
  $id: 'Error',
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        requestId: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
      },
    },
  },
});
app.addSchema({ $id: 'BadRequest', type: 'object', $ref: 'Error#' });
app.addSchema({ $id: 'NotFound', type: 'object', $ref: 'Error#' });
app.addSchema({ $id: 'Conflict', type: 'object', $ref: 'Error#' });

app.setErrorHandler(errorHandler);

app.get('/health', async () => ({
  status: 'ok',
  version: '0.1.0',
  environment: config.NODE_ENV,
  storageAdapter,
  database: usingPostgres ? databaseName : usingSqlite ? sqlitePath : 'disabled',
  cacheAdapter,
  // didMethod/issuerDid: exposed so test harnesses (see
  // tests/utils/liveApi.ts) can read back the actual resolved issuer DID
  // instead of duplicating loadConfig()'s did:key/did:web auto-derivation
  // logic — the issuer DID isn't always known in advance (e.g. did:web's
  // domain includes a dynamically-chosen port in tests).
  didMethod,
  issuerDid: config.HELIX_ISSUER_DID,
}));

function getDatabaseName(databaseUrl: string | undefined): string {
  if (!databaseUrl) return 'none';
  try {
    return new URL(databaseUrl).pathname.replace(/^\//, '');
  } catch {
    return 'unknown';
  }
}

async function ensureIssuerDidCached(): Promise<void> {
  const expectedPublicKey = derivePublicKey(config.HELIX_SIGNING_KEY).toLowerCase();
  const existing = await didRepository.findDidById(config.HELIX_ISSUER_DID);
  if (existing) {
    const existingPublicKey = extractEd25519PublicKeyHexFromDIDDocument(existing.didDocument);
    if (existingPublicKey !== expectedPublicKey) {
      throw new Error(
        'Configured issuer DID public key does not match HELIX_SIGNING_KEY. ' +
          'Run setup with matching issuer material or fix HELIX_ISSUER_DID before issuing VCs.',
      );
    }
    return;
  }

  const didDocument = buildDIDDocument(config.HELIX_ISSUER_DID, expectedPublicKey);
  await didRepository.createDid({
    id: config.HELIX_ISSUER_DID,
    subjectType: 'user',
    controller: config.HELIX_ISSUER_DID,
    publicKey: expectedPublicKey,
    publicKeyMultibase: didDocument.verificationMethod[0]!.publicKeyMultibase,
    hederaTransactionId: `configured-issuer:${config.HELIX_ISSUER_DID}`,
    didDocument,
  });
}

await app.register(didRoutes, { didService });
await app.register(didWebRoutes, { issuerDid: config.HELIX_ISSUER_DID, didDomain: config.DID_DOMAIN, didRepository });
await app.register(vcRoutes, {
  prefix: '/v1/vcs',
  vcService,
  adminApiKey: config.HELIX_ADMIN_API_KEY,
});
await app.register(statusListRoutes, {
  prefix: '/v1/status-list',
  vcService,
  adminApiKey: config.HELIX_ADMIN_API_KEY,
});
await app.register(vpRoutes, { prefix: '/v1/vp', vpService });
await app.register(sessionRoutes, {
  prefix: '/v1/sessions',
  publicKeyHex: jwtSessionKeyPair.publicKey,
});
await app.register(auditLogRoutes, {
  prefix: '/v1/audit-log',
  audit,
  adminApiKey: config.HELIX_ADMIN_API_KEY,
});
await app.register(auditRoutes, {
  prefix: '/v1/audit',
  audit,
  adminApiKey: config.HELIX_ADMIN_API_KEY,
});
await app.register(agentRoutes, {
  prefix: '/v1',
  agentService,
  adminApiKey: config.HELIX_ADMIN_API_KEY,
});
await app.register(serviceProviderRoutes, {
  prefix: '/v1',
  serviceProviderService,
  adminApiKey: config.HELIX_ADMIN_API_KEY,
});

const shutdown = async (): Promise<void> => {
  app.log.info('Helix ID API shutting down...');
  await app.close();
  (redis as Redis | null)?.disconnect();
  await prisma?.$disconnect();
  await pool?.end();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
