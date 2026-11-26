-- A DID document's top-level controller is optional (DID Core §5.1.2): a document another
-- system publishes may leave it out, and an agent with no account DID has none.
ALTER TABLE "dids" ALTER COLUMN "controller" DROP NOT NULL;
