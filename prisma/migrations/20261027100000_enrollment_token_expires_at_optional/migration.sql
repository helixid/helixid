-- An enrollment token without expiresAt onboards an agent whose credential
-- stays valid until revoked (schema.prisma already has EnrollmentToken.expiresAt
-- as DateTime?; 20261015120000_vc_expires_at_optional only relaxed vcs).
ALTER TABLE "enrollment_tokens" ALTER COLUMN "expiresAt" DROP NOT NULL;
