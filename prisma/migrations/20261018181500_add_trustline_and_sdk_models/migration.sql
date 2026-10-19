-- AlterTable
ALTER TABLE "SandboxSession" ADD COLUMN "resetCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastResetAt" TIMESTAMP(3),
ADD COLUMN "jobInFlight" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "activeJobId" TEXT;

-- CreateTable
CREATE TABLE "TrustlineBootstrap" (
    "id" TEXT NOT NULL,
    "walletAddress" VARCHAR(56) NOT NULL,
    "userId" TEXT NOT NULL,
    "assetCode" VARCHAR(12) NOT NULL DEFAULT 'USDC',
    "issuerAddress" VARCHAR(56) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "txHash" VARCHAR(64),
    "error" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sponsoredById" VARCHAR(56),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrustlineBootstrap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SdkBundle" (
    "id" TEXT NOT NULL,
    "cacheKey" VARCHAR(128) NOT NULL,
    "language" VARCHAR(50) NOT NULL,
    "apiVersion" VARCHAR(50) NOT NULL,
    "specRevision" VARCHAR(64) NOT NULL,
    "downloadUrl" VARCHAR(255) NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SdkBundle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrustlineBootstrap_walletAddress_key" ON "TrustlineBootstrap"("walletAddress");
CREATE INDEX "TrustlineBootstrap_walletAddress_idx" ON "TrustlineBootstrap"("walletAddress");
CREATE INDEX "TrustlineBootstrap_status_idx" ON "TrustlineBootstrap"("status");
CREATE INDEX "TrustlineBootstrap_userId_idx" ON "TrustlineBootstrap"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SdkBundle_cacheKey_key" ON "SdkBundle"("cacheKey");
CREATE INDEX "SdkBundle_cacheKey_idx" ON "SdkBundle"("cacheKey");
CREATE INDEX "SdkBundle_expiresAt_idx" ON "SdkBundle"("expiresAt");

-- AddForeignKey
ALTER TABLE "TrustlineBootstrap" ADD CONSTRAINT "TrustlineBootstrap_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
