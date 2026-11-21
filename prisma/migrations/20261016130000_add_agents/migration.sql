-- Onboarded agents as records (name, visibility, own-credential state).
-- Keyed by DID; a hosted build attributes rows to accounts with its own
-- link table, as for services.
CREATE TABLE "agents" (
    "did" TEXT NOT NULL,
    "name" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "visibilityChangedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "credentialVcId" TEXT,
    "credentialExpiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("did")
);

CREATE INDEX "agents_visibility_publishedAt_idx" ON "agents"("visibility", "publishedAt");
CREATE INDEX "agents_credentialVcId_idx" ON "agents"("credentialVcId");
