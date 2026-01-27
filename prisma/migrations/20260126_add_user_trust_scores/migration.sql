-- CreateTable: UserTrustScore
CREATE TABLE "UserTrustScore" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 50,
    "totalVolumeUsdc" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "disputeCount" INTEGER NOT NULL DEFAULT 0,
    "successfulInvoices" INTEGER NOT NULL DEFAULT 0,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserTrustScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserTrustScore_userId_key" ON "UserTrustScore"("userId");

-- CreateIndex
CREATE INDEX "UserTrustScore_userId_idx" ON "UserTrustScore"("userId");

-- AddForeignKey
ALTER TABLE "UserTrustScore" ADD CONSTRAINT "UserTrustScore_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
