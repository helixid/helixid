-- KYA-OS story L3-H: the root delegation signed by the user's did:key at consent.
-- consent_requests: unsigned root grants a service submitted, until the user decides on the page.
-- user_keys: one pairwise did:key per (service, service user) per consent cycle; the private half is in wrapped_keys.
-- user_consents: what the user approved (user-signed), the consented window and the newest hop.
CREATE TABLE "consent_requests" (
    "id" TEXT NOT NULL,
    "serviceDid" TEXT NOT NULL,
    "serviceUserRef" TEXT NOT NULL,
    "agentDid" TEXT NOT NULL,
    "grant_json" JSONB NOT NULL,
    "grantDigest" TEXT NOT NULL,
    "windowUntil" TIMESTAMP(3) NOT NULL,
    "hopLifetimeSeconds" INTEGER,
    "display" JSONB,
    "returnUrl" TEXT,
    "status" TEXT NOT NULL,
    "pageTokenHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "consentId" TEXT,
    CONSTRAINT "consent_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "consent_requests_agentDid_idx" ON "consent_requests"("agentDid");

CREATE TABLE "user_keys" (
    "did" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "serviceDid" TEXT NOT NULL,
    "serviceUserRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shreddedAt" TIMESTAMP(3),
    CONSTRAINT "user_keys_pkey" PRIMARY KEY ("did")
);
CREATE INDEX "user_keys_serviceDid_serviceUserRef_idx" ON "user_keys"("serviceDid", "serviceUserRef");

CREATE TABLE "user_consents" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "userDid" TEXT NOT NULL,
    "serviceDid" TEXT NOT NULL,
    "serviceUserRef" TEXT NOT NULL,
    "agentDid" TEXT NOT NULL,
    "invocationTarget" TEXT NOT NULL,
    "allowedAction" JSONB NOT NULL,
    "caveats" JSONB,
    "windowUntil" TIMESTAMP(3) NOT NULL,
    "hopLifetimeSeconds" INTEGER,
    "consentType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),
    "latestHopId" TEXT NOT NULL,
    "lastHopUntil" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_consents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "user_consents_userDid_idx" ON "user_consents"("userDid");
CREATE INDEX "user_consents_serviceDid_serviceUserRef_idx" ON "user_consents"("serviceDid", "serviceUserRef");
