-- Registry v3: the "Make discoverable" choice an agent was onboarded with (default on).
-- A discoverable agent is listed in the Helix agent registry.
CREATE TABLE "registry_entries" (
    "did" TEXT NOT NULL,
    "discoverable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registry_entries_pkey" PRIMARY KEY ("did")
);
