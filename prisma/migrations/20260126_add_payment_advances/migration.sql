-- CreateTable: PaymentAdvance
CREATE TABLE "PaymentAdvance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "requestedAmountUSDC" DECIMAL(10,2) NOT NULL,
    "advancedAmountUSDC" DECIMAL(10,2) NOT NULL,
    "advancedAmountNGN" DECIMAL(15,2) NOT NULL,
    "exchangeRate" DECIMAL(10,4) NOT NULL,
    "feePercentage" DECIMAL(5,2) NOT NULL DEFAULT 2.00,
    "feeAmountUSDC" DECIMAL(10,2) NOT NULL,
    "totalRepaymentUSDC" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "yellowCardTransactionId" TEXT,
    "disbursedAt" TIMESTAMP(3),
    "repaidAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAdvance_pkey" PRIMARY KEY ("id")
);

-- AlterTable: Add lien field to Invoice
ALTER TABLE "Invoice" ADD COLUMN "lienActive" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "PaymentAdvance_userId_idx" ON "PaymentAdvance"("userId");

-- CreateIndex
CREATE INDEX "PaymentAdvance_invoiceId_idx" ON "PaymentAdvance"("invoiceId");

-- CreateIndex
CREATE INDEX "PaymentAdvance_status_idx" ON "PaymentAdvance"("status");

-- CreateIndex: Prevent multiple active advances on same invoice
CREATE UNIQUE INDEX "PaymentAdvance_one_active_per_invoice" ON "PaymentAdvance"("invoiceId", "status") WHERE "status" IN ('pending', 'disbursed');

-- AddForeignKey
ALTER TABLE "PaymentAdvance" ADD CONSTRAINT "PaymentAdvance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAdvance" ADD CONSTRAINT "PaymentAdvance_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
