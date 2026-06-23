-- CreateTable
CREATE TABLE "SanctionsScreening" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "matchScore" DOUBLE PRECISION,
    "screenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SanctionsScreening_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SanctionsScreening_userId_key" ON "SanctionsScreening"("userId");
CREATE INDEX "SanctionsScreening_status_idx" ON "SanctionsScreening"("status");
CREATE INDEX "SanctionsScreening_screenedAt_idx" ON "SanctionsScreening"("screenedAt");

-- AddForeignKey
ALTER TABLE "SanctionsScreening" ADD CONSTRAINT "SanctionsScreening_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "AccountDeletionRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" VARCHAR(500),
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountDeletionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountDeletionRequest_userId_idx" ON "AccountDeletionRequest"("userId");
CREATE INDEX "AccountDeletionRequest_status_idx" ON "AccountDeletionRequest"("status");
CREATE INDEX "AccountDeletionRequest_scheduledAt_idx" ON "AccountDeletionRequest"("scheduledAt");

-- AddForeignKey
ALTER TABLE "AccountDeletionRequest" ADD CONSTRAINT "AccountDeletionRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "FxRateSnapshot" (
    "id" TEXT NOT NULL,
    "fromCurrency" VARCHAR(8) NOT NULL,
    "toCurrency" VARCHAR(8) NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "source" VARCHAR(50) NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FxRateSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FxRateSnapshot_fromCurrency_toCurrency_capturedAt_idx" ON "FxRateSnapshot"("fromCurrency", "toCurrency", "capturedAt");
CREATE INDEX "FxRateSnapshot_capturedAt_idx" ON "FxRateSnapshot"("capturedAt");
