-- agent_keys becomes did_keys: the one custody table for every private key
-- the platform signs with (agent, service, issuer, user). Existing rows are
-- all agent keys.
ALTER TABLE "agent_keys" RENAME TO "did_keys";
ALTER TABLE "did_keys" RENAME CONSTRAINT "agent_keys_pkey" TO "did_keys_pkey";
ALTER INDEX "agent_keys_did_key" RENAME TO "did_keys_did_key";
ALTER TABLE "did_keys" ADD COLUMN "subjectType" TEXT NOT NULL DEFAULT 'agent';
