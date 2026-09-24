CREATE TABLE "SecurityWatchlistRemovalAudit" (
    "id" TEXT NOT NULL,
    "watchlistId" TEXT NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "value" VARCHAR(255) NOT NULL,
    "additionReason" TEXT NOT NULL,
    "removalReason" TEXT NOT NULL,
    "removedById" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SecurityWatchlistRemovalAudit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SanctionsAppeal" (
    "id" TEXT NOT NULL,
    "screeningId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "SanctionsAppeal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SecurityWatchlistRemovalAudit_watchlistId_idx" ON "SecurityWatchlistRemovalAudit"("watchlistId");
CREATE INDEX "SecurityWatchlistRemovalAudit_value_idx" ON "SecurityWatchlistRemovalAudit"("value");
CREATE INDEX "SecurityWatchlistRemovalAudit_removedById_idx" ON "SecurityWatchlistRemovalAudit"("removedById");
CREATE INDEX "SecurityWatchlistRemovalAudit_removedAt_idx" ON "SecurityWatchlistRemovalAudit"("removedAt");
CREATE INDEX "SanctionsAppeal_screeningId_idx" ON "SanctionsAppeal"("screeningId");
CREATE INDEX "SanctionsAppeal_userId_idx" ON "SanctionsAppeal"("userId");
CREATE INDEX "SanctionsAppeal_status_idx" ON "SanctionsAppeal"("status");
CREATE UNIQUE INDEX "SanctionsAppeal_one_pending_per_screening" ON "SanctionsAppeal"("screeningId") WHERE "status" = 'pending';

ALTER TABLE "SecurityWatchlistRemovalAudit" ADD CONSTRAINT "SecurityWatchlistRemovalAudit_removedById_fkey" FOREIGN KEY ("removedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SanctionsAppeal" ADD CONSTRAINT "SanctionsAppeal_screeningId_fkey" FOREIGN KEY ("screeningId") REFERENCES "SanctionsScreening"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SanctionsAppeal" ADD CONSTRAINT "SanctionsAppeal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
