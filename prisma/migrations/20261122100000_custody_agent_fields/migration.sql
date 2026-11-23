-- KYA-OS story F-3 follow-up: POST /v1/agents takes requestedDomains and
-- maxDelegationDepth, as the agent-create route's enrollment token did.
ALTER TABLE "custody_records" ADD COLUMN "requestedDomains" JSONB;
ALTER TABLE "custody_records" ADD COLUMN "maxDelegationDepth" INTEGER NOT NULL DEFAULT 0;
