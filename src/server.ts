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
  enrollmentOnboardingHandler,
  AgentService,
  auditLogRoutes,
  auditRoutes,
  buildDIDDocument,
  createApiAudit,
  createApiAuditStorage,
  createDidCache,
  createHederaClient,
  createStatusListCache,
  CredentialService,
  credentialCardDetails,
  createEntityCardSource,
  CustodyRecheckScheduler,
  custodyRecheckSettings,
  CustodyRepository,
  custodyRoutes,
  CustodyService,
  derivePublicKey,
  DidKeyRepository,
  DidRepository,
  didRoutes,
  DIDService,
  EnvSigner,
  didWebRoutes,
  errorHandler,
  entityCardRoutes,
  eventRoutes,
  extractEd25519PublicKeyHexFromDIDDocument,
  generateKeyPair,
  loadConfigFromEnv,
  publicDidResolver,
  RedisSignalBus,
  resolveDID as resolveDIDCore,
  resolveDidMethod,
  revocationRoutes,
  RevocationService,
  RevocationSignalPublisher,
  serviceProviderRoutes,
  ServiceProviderService,
  ServiceRepository,
  sessionRoutes,
  SqliteStore,
  StatusListPublisher,
  statusListRoutes,
  StatusListService,
  VcRepository,
  vcRoutes,
  VCService,
  verifyRoutes,
  type DIDDocument,
  type DidResolver,
  type RedisLike,
  type RedisPubSubLike,
  type Signer,
} from '@helixid/core';
import { SelfCustodyOnlyKeyStore, selfCustodyAuthorize } from './self-custody.js';

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
// Agent self-custody has been retired — every agent's private key is now
// generated and held here, encrypted with this one shared master key. Unset
// in dev falls back to a random per-process key (fine for local dev; means
// encrypted DidKey rows don't survive a restart in that mode) — same
// pattern as HOSTED_ACCESS_TOKEN_SECRET below it.
const agentKeyEncryptionKey = config.HOSTED_KEY_ENCRYPTION_KEY ?? crypto.randomBytes(32).toString('hex');
const keyCustody = new AesGcmKeyCustody(agentKeyEncryptionKey);
// KYA-OS story F-1: identity, attestations and hops. The Helix issuer signs
// through an EnvSigner (the key stays in HELIX_SIGNING_KEY); custodial keys
// sign through the key custody. Copies land in the vcs table for the console.
const helixSigner = new EnvSigner({ did: config.HELIX_ISSUER_DID });
// Public DID resolution: the keys of revokers and of issuers that sign their own lists.
const resolvePublicDid: DidResolver = publicDidResolver(resolveDIDCore);
// KYA-OS story L3-C: one signed Bitstring Status List v1.0 per issuer DID, signed through that issuer's Signer.
const statusListPublisher: StatusListPublisher = new StatusListPublisher({
  repo: vcRepository,
  helixIssuerDid: config.HELIX_ISSUER_DID,
  apiBaseUrl: config.API_BASE_URL,
  // The Helix issuer, or a key Helix holds (KeyStore, rule 8); undefined for a self-custody issuer, who signs its own list.
  signerFor: async (did): Promise<Signer | undefined> => {
    try {
      return await credentialService.signerFor(did);
    } catch {
      return undefined;
    }
  },
  resolveDid: resolvePublicDid,
  listTtlSeconds: config.STATUS_LIST_TTL_SECONDS,
  refreshBeforeSeconds: config.STATUS_LIST_REFRESH_BEFORE_SECONDS,
  signedCache: statusListCache,
  audit: auditTrail,
});
const statusListService: StatusListService = new StatusListService({ publisher: statusListPublisher, repo: vcRepository, audit: auditTrail });
const credentialService: CredentialService = new CredentialService(
  vcRepository,
  statusListService,
  didService,
  helixSigner,
  didKeyRepository,
  keyCustody,
  auditTrail,
);
// One SET per revocation, signed by the Helix issuer; across instances through Redis pub/sub when Redis is configured.
const revocationSignals = new RevocationSignalPublisher({
  signer: helixSigner,
  ...(redis && config.REDIS_URL
    ? { bus: new RedisSignalBus({ publisher: new Redis(config.REDIS_URL) as unknown as RedisPubSubLike, subscriber: new Redis(config.REDIS_URL) as unknown as RedisPubSubLike }) }
    : {}),
  webhooks: (config.REVOCATION_WEBHOOK_URLS ?? '').split(',').map((url) => url.trim()).filter((url) => url.length > 0),
  audit: auditTrail,
});
statusListService.setSignals(revocationSignals);
statusListPublisher.startRefresh();
const revocationService = new RevocationService({
  repo: vcRepository,
  statusLists: statusListService,
  resolveDid: resolvePublicDid,
  audience: `${config.API_BASE_URL}/v1/revocations`,
});
const agentService = new AgentService(
  agentRepository,
  didService,
  vcService,
  auditTrail,
  didKeyRepository,
  keyCustody,
  credentialService,
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

// KYA-OS stories F-3 and C-A on the open-source server: Helix-hosted agents
// with their DID documents and Entity Cards, self-custody only. The agent
// generates and holds its key (helix init / helix activate); Helix learns only
// the public JWK. So there is no DbKeyStore here: the custody service gets a
// KeyStore that holds nothing, the custody routes refuse keyCustody 'helix'
// and /sign (see self-custody.ts), and no grant, hop or status list is signed
// with a custodial key.
const custodyService = new CustodyService({
  records: new CustodyRepository(prisma, sqlite),
  keyStore: new SelfCustodyOnlyKeyStore(),
  didRepository,
  credentials: credentialService,
  services: serviceRepository,
  auditTrail,
  host: config.DID_DOMAIN,
  didCache,
  recheck: custodyRecheckSettings(config),
  credentialDetails: credentialCardDetails(vcService),
  // KYA-OS story C-E: a self-custody agent rotates its key with the SDK's rotateKey();
  // both keys stay listed for KEY_ROTATION_OVERLAP_SECONDS, and its leaf hops are reissued.
  rotationOverlapSeconds: config.KEY_ROTATION_OVERLAP_SECONDS,
  hopReissuer: credentialService,
});
// Own-hosted agents waiting for their documents are re-checked in the background.
const custodyRecheck = new CustodyRecheckScheduler(custodyService, { tickSeconds: config.CUSTODY_RECHECK_TICK_SECONDS });

const app = Fastify({
  logger: {
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    redact: ['req.headers.authorization', 'req.body.privateKey', 'req.body.privateKeyHex'],
  },
  genReqId: () => `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
  // KYA-OS story L3-C: a per-issuer status list's id is `iss-` + base64url(issuer DID), and a hosted
  // did:web makes it longer than Fastify's default 100-character route parameter (414). 2048 holds
  // the id of any DID a URL can carry.
  routerOptions: { maxParamLength: 2048 },
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
  credentialService,
  statusLists: statusListService,
  adminApiKey: config.HELIX_ADMIN_API_KEY,
});
await app.register(statusListRoutes, {
  prefix: '/v1/status-list',
  statusLists: statusListService,
  adminApiKey: config.HELIX_ADMIN_API_KEY,
});
// KYA-OS story L3-C: signed revocation requests, cascading, and the revocation signal (SSE + RFC 8935 push).
await app.register(revocationRoutes, {
  prefix: '/v1/revocations',
  revocations: revocationService,
  signerFor: (did) => credentialService.signerFor(did),
  adminApiKey: config.HELIX_ADMIN_API_KEY,
});
await app.register(eventRoutes, { prefix: '/v1/events', signals: revocationSignals, adminApiKey: config.HELIX_ADMIN_API_KEY });
// KYA-OS story F-2: the local verifier over HTTP; /v1/vp/verify is retired. It reads no database.
await app.register(verifyRoutes, { prefix: '/v1/verify', allowLoopbackHttp: config.NODE_ENV !== 'production' });
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
  credentialService,
  adminApiKey: config.HELIX_ADMIN_API_KEY,
  // KYA-OS story F-3: the custody routes own POST /v1/agents.
  createAgentRoute: false,
});
await app.register(serviceProviderRoutes, {
  prefix: '/v1',
  serviceProviderService,
  adminApiKey: config.HELIX_ADMIN_API_KEY,
});
await app.register(custodyRoutes, {
  prefix: '/v1',
  custodyService,
  authorize: selfCustodyAuthorize(config.HELIX_ADMIN_API_KEY),
  // A POST /v1/agents body with enrollmentToken is story F-1's token onboarding, unchanged.
  enrollmentOnboarding: enrollmentOnboardingHandler(agentService),
  // KYA-OS story C-E point 5: an ancestor issuer of an agent's delegations may revoke its compromised key.
  keyRevocations: revocationService,
});
// KYA-OS story C-A: /{path}/did.json, /{path}/card.json and /.well-known/kya-os-card.json; after the static routes, so the wildcard never shadows them.
await app.register(entityCardRoutes, { source: createEntityCardSource({ host: config.DID_DOMAIN, didRepository, services: serviceRepository, details: (did) => custodyService.cardDetails(did), credentials: credentialCardDetails(vcService) }) });

const shutdown = async (): Promise<void> => {
  app.log.info('Helix ID API shutting down...');
  await app.close();
  await custodyRecheck.stop();
  statusListPublisher.stopRefresh();
  await revocationSignals.close();
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
    if (config.CUSTODY_RECHECK_ENABLED) custodyRecheck.start();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
