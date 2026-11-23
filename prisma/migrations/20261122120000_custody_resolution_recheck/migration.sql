-- KYA-OS story F-3 follow-up: own-hosted subjects waiting for their documents
-- (pending_resolution) are re-checked in the background, with backoff, for a
-- bounded time.
ALTER TABLE "custody_records" ADD COLUMN "pendingResolutionSince" TIMESTAMP(3);
ALTER TABLE "custody_records" ADD COLUMN "recheckAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "custody_records" ADD COLUMN "nextRecheckAt" TIMESTAMP(3);
CREATE INDEX "custody_records_status_nextRecheckAt_idx" ON "custody_records"("status", "nextRecheckAt");
-- Subjects already waiting are due at once; they wait since their last update.
UPDATE "custody_records" SET "pendingResolutionSince" = "updatedAt", "nextRecheckAt" = CURRENT_TIMESTAMP WHERE "status" = 'pending_resolution';
