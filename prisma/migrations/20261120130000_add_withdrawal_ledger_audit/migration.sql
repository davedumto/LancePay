-- CreateTable
CREATE TABLE "WithdrawalLedgerAudit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ledgerAvailable" DECIMAL(18,7) NOT NULL,
    "onChainUsdc" DECIMAL(18,7) NOT NULL,
    "drift" DECIMAL(18,7) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WithdrawalLedgerAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WithdrawalLedgerAudit_userId_idx" ON "WithdrawalLedgerAudit"("userId");

-- CreateIndex
CREATE INDEX "WithdrawalLedgerAudit_createdAt_idx" ON "WithdrawalLedgerAudit"("createdAt");

-- AddForeignKey
ALTER TABLE "WithdrawalLedgerAudit" ADD CONSTRAINT "WithdrawalLedgerAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
