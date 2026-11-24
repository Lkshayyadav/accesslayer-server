-- CreateTable
CREATE TABLE "public_profiles" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "showHoldings" BOOLEAN NOT NULL DEFAULT true,
    "showPnl" BOOLEAN NOT NULL DEFAULT true,
    "showKeyCount" BOOLEAN NOT NULL DEFAULT true,
    "showJoined" BOOLEAN NOT NULL DEFAULT true,
    "showWallet" BOOLEAN NOT NULL DEFAULT false,
    "hideExactAmounts" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "public_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "public_profiles_wallet_key" ON "public_profiles"("wallet");

-- CreateIndex
CREATE UNIQUE INDEX "public_profiles_handle_key" ON "public_profiles"("handle");

-- CreateIndex
CREATE INDEX "public_profiles_handle_idx" ON "public_profiles"("handle");
