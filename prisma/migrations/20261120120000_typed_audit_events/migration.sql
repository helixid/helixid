-- Story A-1: the legacy free-form audit_log is replaced, not wrapped (no
-- backward compatibility with its rows). KYA-OS producer events and the
-- evidence vault take its place; both are append-only with no delete path.
DROP TABLE IF EXISTS "audit_log";

CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceSequence" BIGINT,
    "previousSourceEventDigest" TEXT,
    "eventDigest" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlationId" TEXT,
    "actorRef" TEXT,
    "canonical" TEXT NOT NULL,
    "event" JSONB NOT NULL,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "audit_events_eventDigest_key" ON "audit_events"("eventDigest");
CREATE UNIQUE INDEX "audit_events_sourceId_eventId_key" ON "audit_events"("sourceId", "eventId");
CREATE INDEX "audit_events_eventType_recordedAt_idx" ON "audit_events"("eventType", "recordedAt");
CREATE INDEX "audit_events_family_recordedAt_idx" ON "audit_events"("family", "recordedAt");
CREATE INDEX "audit_events_correlationId_idx" ON "audit_events"("correlationId");
CREATE INDEX "audit_events_actorRef_idx" ON "audit_events"("actorRef");

CREATE TABLE "audit_evidence" (
    "objectId" TEXT NOT NULL,
    "ciphertextDigest" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "ref" JSONB NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "storedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_evidence_pkey" PRIMARY KEY ("objectId")
);
