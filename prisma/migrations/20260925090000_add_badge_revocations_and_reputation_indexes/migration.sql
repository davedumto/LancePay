-- UserBadge rows are now recorded when eligibility is awarded; the soulbound
-- token is minted separately, so the Stellar tx hash is unknown at insert time.
ALTER TABLE "UserBadge" ALTER COLUMN "stellarTxHash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "UserBadgeRevocation" (
    "id" TEXT NOT NULL,
    "userBadgeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "badgeId" TEXT NOT NULL,
    "stellarTxHash" VARCHAR(255),
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "trigger" VARCHAR(50) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "revokedById" TEXT,
    "revokedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBadgeRevocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserBadgeRevocation_userId_badgeId_idx" ON "UserBadgeRevocation"("userId", "badgeId");
CREATE INDEX "UserBadgeRevocation_revokedById_idx" ON "UserBadgeRevocation"("revokedById");
CREATE INDEX "UserBadgeRevocation_revokedAt_idx" ON "UserBadgeRevocation"("revokedAt");
CREATE INDEX "Invoice_userId_idx" ON "Invoice"("userId");
CREATE INDEX "Invoice_clientEmail_idx" ON "Invoice"("clientEmail");

-- AddForeignKey
ALTER TABLE "UserBadgeRevocation" ADD CONSTRAINT "UserBadgeRevocation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserBadgeRevocation" ADD CONSTRAINT "UserBadgeRevocation_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "BadgeDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserBadgeRevocation" ADD CONSTRAINT "UserBadgeRevocation_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
