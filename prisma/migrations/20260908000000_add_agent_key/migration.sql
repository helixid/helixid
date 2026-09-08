-- CreateTable
CREATE TABLE "agent_keys" (
    "id" TEXT NOT NULL,
    "did" TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_keys_did_key" ON "agent_keys"("did");
