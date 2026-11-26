-- KYA-OS story F-3: custody preference at onboarding.
-- custody_records: the custody choice of each agent, service and owner.
-- custody_keys: every key a subject has had (public half), for rotation.
-- wrapped_keys: Helix-held private keys, AES-256-GCM wrapped, KeyStore only.
CREATE TABLE "custody_records" (
    "did" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "keyCustody" TEXT NOT NULL,
    "didHosting" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "kid" TEXT,
    "name" TEXT,
    "ownerDid" TEXT,
    "scopes" JSONB,
    "enrollmentTokenHash" TEXT,
    "enrollmentExpiresAt" TIMESTAMP(3),
    "enrollmentNonce" TEXT,
    "enrollmentUsedAt" TIMESTAMP(3),
    "credentialVcId" TEXT,
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custody_records_pkey" PRIMARY KEY ("did")
);

CREATE UNIQUE INDEX "custody_records_enrollmentTokenHash_key" ON "custody_records"("enrollmentTokenHash");
CREATE INDEX "custody_records_subjectType_keyCustody_idx" ON "custody_records"("subjectType", "keyCustody");

CREATE TABLE "custody_keys" (
    "id" TEXT NOT NULL,
    "did" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "publicKeyJwk" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "custody_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "custody_keys_did_kid_key" ON "custody_keys"("did", "kid");

ALTER TABLE "custody_keys" ADD CONSTRAINT "custody_keys_did_fkey" FOREIGN KEY ("did") REFERENCES "custody_records"("did") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "wrapped_keys" (
    "id" TEXT NOT NULL,
    "did" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "kekId" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "publicKeyJwk" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shreddedAt" TIMESTAMP(3),

    CONSTRAINT "wrapped_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wrapped_keys_did_kid_key" ON "wrapped_keys"("did", "kid");
CREATE INDEX "wrapped_keys_did_idx" ON "wrapped_keys"("did");
