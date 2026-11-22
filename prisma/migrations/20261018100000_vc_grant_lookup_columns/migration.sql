-- Lookup columns for `vcs`, denormalised from vcJson: the credential's own
-- type, its issuer, the user a consent grant was issued on behalf of, and
-- the canonical scope set (sorted, space-joined). Lets a consent grant be
-- found by its (user, agent, service) triple without scanning JSON.
ALTER TABLE "vcs" ADD COLUMN "vcType" TEXT;
ALTER TABLE "vcs" ADD COLUMN "issuerDid" TEXT;
ALTER TABLE "vcs" ADD COLUMN "userDid" TEXT;
ALTER TABLE "vcs" ADD COLUMN "scopeKey" TEXT;

-- Backfill from the stored JSON.
UPDATE "vcs" SET
  "vcType" = (
    SELECT t FROM jsonb_array_elements_text("vcJson"->'type') AS t
    WHERE t <> 'VerifiableCredential' LIMIT 1
  ),
  "issuerDid" = "vcJson"->>'issuer',
  "userDid" = "vcJson"->'credentialSubject'->>'userDid',
  "scopeKey" = (
    SELECT string_agg(DISTINCT s, ' ' ORDER BY s)
    FROM jsonb_array_elements_text(
      COALESCE("vcJson"->'credentialSubject'->'scopes', "vcJson"->'credentialSubject'->'privilegeScopes', '[]'::jsonb)
    ) AS s
  );

CREATE INDEX "vcs_subjectDid_vcType_issuerDid_userDid_idx"
  ON "vcs"("subjectDid", "vcType", "issuerDid", "userDid");
