-- Enrolled Service Providers (identity side; key material is in did_keys).
CREATE TABLE "services" (
    "id" TEXT NOT NULL,
    "did" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "requiredScope" TEXT NOT NULL,
    "description" TEXT,
    "framework" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "services_did_key" ON "services"("did");
CREATE INDEX "services_name_idx" ON "services"("name");
