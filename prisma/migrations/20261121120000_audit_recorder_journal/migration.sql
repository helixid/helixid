-- Story A-2 (AAP-2 Chained): the authoritative recorder's atomic journal.
--
-- A-1's capture table "audit_events" is replaced by the journal: every event
-- now enters through the recorder, which assigns epoch, sequence, predecessor
-- digest and service time and signs a receipt. No backward compatibility with
-- A-1 capture rows (A-1 is unreleased).
--
-- Append-only is enforced here as well as in code: triggers refuse UPDATE,
-- DELETE and TRUNCATE on the journal, refuse an insert that is not the next
-- entry of an active epoch, let an epoch head only advance by one onto an
-- entry that exists or be sealed once, and let an evidence row change only
-- by having its ciphertext disposed. A superuser can still disable triggers;
-- that is what `helix-audit verify` detects.
DROP TABLE IF EXISTS "audit_events";

-- One ledger per tenant. "tenantKey" is the RFC 8785 text of "tenantRef".
CREATE TABLE "audit_ledgers" (
    "ledgerId" TEXT NOT NULL,
    "tenantKey" TEXT NOT NULL,
    "tenantRef" JSONB NOT NULL,
    "activeEpochId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_ledgers_pkey" PRIMARY KEY ("ledgerId")
);
CREATE UNIQUE INDEX "audit_ledgers_tenantKey_key" ON "audit_ledgers"("tenantKey");

-- The ledger-head row: one per epoch, holding its committed head, its one
-- recorder authority (the signer of its genesis) and, once closed, its seal.
CREATE TABLE "audit_ledger_heads" (
    "ledgerId" TEXT NOT NULL,
    "ledgerEpochId" TEXT NOT NULL,
    "position" BIGSERIAL NOT NULL,
    "sequence" BIGINT NOT NULL,
    "entryDigest" TEXT NOT NULL,
    "recorderDid" TEXT NOT NULL,
    "recorderKid" TEXT NOT NULL,
    "recorderAlg" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "terminalDigest" TEXT,
    "sealReason" TEXT,
    "successorEpochId" TEXT,
    "sealedAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_ledger_heads_pkey" PRIMARY KEY ("ledgerId", "ledgerEpochId"),
    CONSTRAINT "audit_ledger_heads_status_check" CHECK ("status" IN ('active', 'sealed'))
);
CREATE UNIQUE INDEX "audit_ledger_heads_position_key" ON "audit_ledger_heads"("position");

-- The journal. "entry" is the RFC 8785 text of the signed entry, byte-exact;
-- the other columns index it and are checked against it by the verifier.
CREATE TABLE "audit_journal_entries" (
    "id" BIGSERIAL NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "ledgerEpochId" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "eventDigest" TEXT NOT NULL,
    "entryDigest" TEXT NOT NULL,
    "previousEntryDigest" TEXT,
    "recordedAt" BIGINT NOT NULL,
    "correlationId" TEXT,
    "entry" TEXT NOT NULL,
    "insertedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_journal_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "audit_journal_entries_ledgerId_ledgerEpochId_sequence_key" ON "audit_journal_entries"("ledgerId", "ledgerEpochId", "sequence");
CREATE UNIQUE INDEX "audit_journal_entries_ledgerId_idempotencyKey_key" ON "audit_journal_entries"("ledgerId", "idempotencyKey");
CREATE INDEX "audit_journal_entries_eventType_recordedAt_idx" ON "audit_journal_entries"("eventType", "recordedAt");
CREATE INDEX "audit_journal_entries_family_recordedAt_idx" ON "audit_journal_entries"("family", "recordedAt");
CREATE INDEX "audit_journal_entries_correlationId_idx" ON "audit_journal_entries"("correlationId");
CREATE INDEX "audit_journal_entries_recordedAt_idx" ON "audit_journal_entries"("recordedAt");

-- Legal holds: applied once, released once, never deleted.
CREATE TABLE "audit_legal_holds" (
    "holdId" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "objectId" TEXT,
    "target" JSONB NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL,
    "appliedBy" TEXT NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "releasedBy" TEXT,

    CONSTRAINT "audit_legal_holds_pkey" PRIMARY KEY ("holdId")
);
CREATE INDEX "audit_legal_holds_ledgerId_idx" ON "audit_legal_holds"("ledgerId");
CREATE INDEX "audit_legal_holds_objectId_idx" ON "audit_legal_holds"("objectId");

-- Disposal removes ciphertext, never the reference (AUDITABILITY.md).
ALTER TABLE "audit_evidence" ALTER COLUMN "ciphertext" DROP NOT NULL;
ALTER TABLE "audit_evidence" ADD COLUMN "disposedAt" TIMESTAMP(3);
ALTER TABLE "audit_evidence" ADD COLUMN "disposalReason" TEXT;

-- ── triggers ──────────────────────────────────────────────────────────────────

CREATE FUNCTION "audit_refuse_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit storage is append-only: % on % refused', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE FUNCTION "audit_journal_insert_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  head RECORD;
BEGIN
  SELECT "sequence", "entryDigest", "status", "recorderDid", "recorderKid", "recorderAlg" INTO head
    FROM "audit_ledger_heads" WHERE "ledgerId" = NEW."ledgerId" AND "ledgerEpochId" = NEW."ledgerEpochId";
  IF NOT FOUND THEN
    IF NEW."sequence" <> 0 OR NEW."previousEntryDigest" IS NOT NULL THEN
      RAISE EXCEPTION 'audit journal: the first entry of an epoch is its genesis at sequence 0' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF head."status" <> 'active' THEN
    RAISE EXCEPTION 'audit journal: epoch % is sealed', NEW."ledgerEpochId" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sequence" <> head."sequence" + 1 OR NEW."previousEntryDigest" IS DISTINCT FROM head."entryDigest" THEN
    RAISE EXCEPTION 'audit journal: an entry must be the next one after the committed head' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "audit_head_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."sequence" <> 0 OR NEW."status" <> 'active' OR NOT EXISTS (
      SELECT 1 FROM "audit_journal_entries"
       WHERE "ledgerId" = NEW."ledgerId" AND "ledgerEpochId" = NEW."ledgerEpochId" AND "sequence" = 0 AND "entryDigest" = NEW."entryDigest"
    ) THEN
      RAISE EXCEPTION 'audit head: an epoch head starts at its stored genesis' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'sealed' THEN
    RAISE EXCEPTION 'audit head: epoch % is sealed', OLD."ledgerEpochId" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."ledgerId" <> OLD."ledgerId" OR NEW."ledgerEpochId" <> OLD."ledgerEpochId" OR NEW."position" <> OLD."position"
     OR NEW."recorderDid" <> OLD."recorderDid" OR NEW."recorderKid" <> OLD."recorderKid" OR NEW."recorderAlg" <> OLD."recorderAlg"
     OR NEW."openedAt" <> OLD."openedAt" THEN
    RAISE EXCEPTION 'audit head: an epoch''s identity and authority never change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'active' THEN
    IF NEW."sequence" <> OLD."sequence" + 1 OR NEW."terminalDigest" IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM "audit_journal_entries"
       WHERE "ledgerId" = NEW."ledgerId" AND "ledgerEpochId" = NEW."ledgerEpochId" AND "sequence" = NEW."sequence" AND "entryDigest" = NEW."entryDigest"
    ) THEN
      RAISE EXCEPTION 'audit head: a head only advances by one onto a stored entry' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."sequence" <> OLD."sequence" OR NEW."entryDigest" <> OLD."entryDigest" OR NEW."terminalDigest" IS NULL OR NEW."successorEpochId" IS NULL THEN
      RAISE EXCEPTION 'audit head: an epoch is sealed at its committed head with a terminal digest and a successor' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "audit_ledger_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."ledgerId" <> OLD."ledgerId" OR NEW."tenantKey" <> OLD."tenantKey" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'audit ledger: a ledger''s tenant never changes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "audit_hold_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."releasedAt" IS NOT NULL OR NEW."releasedAt" IS NULL OR NEW."holdId" <> OLD."holdId" OR NEW."ledgerId" <> OLD."ledgerId"
     OR NEW."target" <> OLD."target" OR NEW."appliedAt" <> OLD."appliedAt" OR NEW."appliedBy" <> OLD."appliedBy" THEN
    RAISE EXCEPTION 'audit legal hold: a hold is only ever released, once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "audit_evidence_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."disposedAt" IS NOT NULL OR NEW."disposedAt" IS NULL OR NEW."ciphertext" IS NOT NULL
     OR NEW."objectId" <> OLD."objectId" OR NEW."ciphertextDigest" <> OLD."ciphertextDigest" OR NEW."ref" <> OLD."ref" THEN
    RAISE EXCEPTION 'audit evidence: an object only ever has its ciphertext disposed, once' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "audit_legal_holds" WHERE "releasedAt" IS NULL AND "targetKind" = 'evidence' AND "objectId" = OLD."objectId") THEN
    RAISE EXCEPTION 'audit evidence: object % is under legal hold', OLD."objectId" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "audit_journal_entries_insert_guard" BEFORE INSERT ON "audit_journal_entries"
  FOR EACH ROW EXECUTE FUNCTION "audit_journal_insert_guard"();
CREATE TRIGGER "audit_journal_entries_append_only" BEFORE UPDATE OR DELETE ON "audit_journal_entries"
  FOR EACH ROW EXECUTE FUNCTION "audit_refuse_mutation"();
CREATE TRIGGER "audit_journal_entries_no_truncate" BEFORE TRUNCATE ON "audit_journal_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_refuse_mutation"();

CREATE TRIGGER "audit_ledger_heads_guard" BEFORE INSERT OR UPDATE ON "audit_ledger_heads"
  FOR EACH ROW EXECUTE FUNCTION "audit_head_guard"();
CREATE TRIGGER "audit_ledger_heads_no_delete" BEFORE DELETE ON "audit_ledger_heads"
  FOR EACH ROW EXECUTE FUNCTION "audit_refuse_mutation"();
CREATE TRIGGER "audit_ledger_heads_no_truncate" BEFORE TRUNCATE ON "audit_ledger_heads"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_refuse_mutation"();

CREATE TRIGGER "audit_ledgers_guard" BEFORE UPDATE ON "audit_ledgers"
  FOR EACH ROW EXECUTE FUNCTION "audit_ledger_guard"();
CREATE TRIGGER "audit_ledgers_no_delete" BEFORE DELETE ON "audit_ledgers"
  FOR EACH ROW EXECUTE FUNCTION "audit_refuse_mutation"();
CREATE TRIGGER "audit_ledgers_no_truncate" BEFORE TRUNCATE ON "audit_ledgers"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_refuse_mutation"();

CREATE TRIGGER "audit_legal_holds_guard" BEFORE UPDATE ON "audit_legal_holds"
  FOR EACH ROW EXECUTE FUNCTION "audit_hold_guard"();
CREATE TRIGGER "audit_legal_holds_no_delete" BEFORE DELETE ON "audit_legal_holds"
  FOR EACH ROW EXECUTE FUNCTION "audit_refuse_mutation"();
CREATE TRIGGER "audit_legal_holds_no_truncate" BEFORE TRUNCATE ON "audit_legal_holds"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_refuse_mutation"();

CREATE TRIGGER "audit_evidence_guard" BEFORE UPDATE ON "audit_evidence"
  FOR EACH ROW EXECUTE FUNCTION "audit_evidence_guard"();
CREATE TRIGGER "audit_evidence_no_delete" BEFORE DELETE ON "audit_evidence"
  FOR EACH ROW EXECUTE FUNCTION "audit_refuse_mutation"();
CREATE TRIGGER "audit_evidence_no_truncate" BEFORE TRUNCATE ON "audit_evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_refuse_mutation"();

-- No role but the table owner gets to change these tables; deployments that
-- run the API as a separate role grant it INSERT and SELECT only on the journal.
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_journal_entries", "audit_ledger_heads", "audit_ledgers", "audit_legal_holds", "audit_evidence" FROM PUBLIC;
