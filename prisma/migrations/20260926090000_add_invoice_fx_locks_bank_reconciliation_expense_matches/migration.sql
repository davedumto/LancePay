-- AlterTable
ALTER TABLE "User" ADD COLUMN "homeCurrency" VARCHAR(8) NOT NULL DEFAULT 'NGN';

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN "projectId" TEXT;

-- AlterTable
ALTER TABLE "ManualPayment" ADD COLUMN "bankStatementLineId" TEXT,
ADD COLUMN "reconciledAt" TIMESTAMP(3),
ADD COLUMN "reconciledBy" TEXT;

-- CreateTable
CREATE TABLE "BankStatementLine" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "transactionDate" DATE NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "currency" VARCHAR(8) NOT NULL DEFAULT 'NGN',
    "description" VARCHAR(255),
    "reference" VARCHAR(100),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankStatementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseReimbursementMatch" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseReimbursementMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceFxLock" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "fxRateSnapshotId" TEXT NOT NULL,
    "inverted" BOOLEAN NOT NULL DEFAULT false,
    "sourceAmount" DECIMAL(10,2) NOT NULL,
    "sourceCurrency" VARCHAR(8) NOT NULL,
    "lockedAmount" DECIMAL(15,2) NOT NULL,
    "lockedCurrency" VARCHAR(8) NOT NULL,
    "lockedBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceFxLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManualPayment_bankStatementLineId_key" ON "ManualPayment"("bankStatementLineId");

-- CreateIndex
CREATE INDEX "ManualPayment_reconciledBy_idx" ON "ManualPayment"("reconciledBy");

-- CreateIndex
CREATE INDEX "BankStatementLine_userId_transactionDate_idx" ON "BankStatementLine"("userId", "transactionDate");

-- CreateIndex
CREATE INDEX "Expense_projectId_idx" ON "Expense"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseReimbursementMatch_expenseId_key" ON "ExpenseReimbursementMatch"("expenseId");

-- CreateIndex
CREATE INDEX "ExpenseReimbursementMatch_invoiceId_idx" ON "ExpenseReimbursementMatch"("invoiceId");

-- CreateIndex
CREATE INDEX "InvoiceFxLock_invoiceId_createdAt_idx" ON "InvoiceFxLock"("invoiceId", "createdAt");

-- CreateIndex
CREATE INDEX "InvoiceFxLock_fxRateSnapshotId_idx" ON "InvoiceFxLock"("fxRateSnapshotId");

-- CreateIndex
CREATE INDEX "InvoiceFxLock_lockedBy_idx" ON "InvoiceFxLock"("lockedBy");

-- AddForeignKey
ALTER TABLE "ManualPayment" ADD CONSTRAINT "ManualPayment_reconciledBy_fkey" FOREIGN KEY ("reconciledBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualPayment" ADD CONSTRAINT "ManualPayment_bankStatementLineId_fkey" FOREIGN KEY ("bankStatementLineId") REFERENCES "BankStatementLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatementLine" ADD CONSTRAINT "BankStatementLine_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseReimbursementMatch" ADD CONSTRAINT "ExpenseReimbursementMatch_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseReimbursementMatch" ADD CONSTRAINT "ExpenseReimbursementMatch_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceFxLock" ADD CONSTRAINT "InvoiceFxLock_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceFxLock" ADD CONSTRAINT "InvoiceFxLock_fxRateSnapshotId_fkey" FOREIGN KEY ("fxRateSnapshotId") REFERENCES "FxRateSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceFxLock" ADD CONSTRAINT "InvoiceFxLock_lockedBy_fkey" FOREIGN KEY ("lockedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
