-- CreateTable
CREATE TABLE "AutoSwapRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "percentage" INTEGER NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoSwapRule_pkey" PRIMARY KEY ("id")
);

-- Add columns to User
ALTER TABLE "User" ADD COLUMN "phone" TEXT;
ALTER TABLE "User" ADD COLUMN "twoFactorSecret" TEXT;
ALTER TABLE "User" ADD COLUMN "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "backupCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Add externalId and error column to Transaction
ALTER TABLE "Transaction" ADD COLUMN "externalId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "error" TEXT;
CREATE UNIQUE INDEX "Transaction_externalId_key" ON "Transaction"("externalId");

-- Add autoSwapTriggered column to Transaction
ALTER TABLE "Transaction" ADD COLUMN "autoSwapTriggered" BOOLEAN NOT NULL DEFAULT false;

-- Add escrow fields to Invoice
ALTER TABLE "Invoice" ADD COLUMN "escrowEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Invoice" ADD COLUMN "escrowStatus" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "Invoice" ADD COLUMN "escrowReleaseConditions" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "escrowReleasedAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "escrowDisputedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "AutoSwapRule_userId_key" ON "AutoSwapRule"("userId");

-- AddForeignKey
ALTER TABLE "AutoSwapRule" ADD CONSTRAINT "AutoSwapRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoSwapRule" ADD CONSTRAINT "AutoSwapRule_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable for BulkInvoiceJob
CREATE TABLE "BulkInvoiceJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "totalCount" INTEGER NOT NULL,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "results" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "BulkInvoiceJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BulkInvoiceJob_userId_idx" ON "BulkInvoiceJob"("userId");

-- CreateTable for Dispute
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "initiatedBy" TEXT NOT NULL,
    "initiatorEmail" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedAction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_invoiceId_key" ON "Dispute"("invoiceId");
CREATE INDEX "Dispute_invoiceId_idx" ON "Dispute"("invoiceId");

-- CreateTable for DisputeMessage
CREATE TABLE "DisputeMessage" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "senderType" TEXT NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisputeMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DisputeMessage_disputeId_idx" ON "DisputeMessage"("disputeId");

-- CreateTable for EscrowEvent
CREATE TABLE "EscrowEvent" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorEmail" TEXT NOT NULL,
    "notes" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EscrowEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EscrowEvent_invoiceId_idx" ON "EscrowEvent"("invoiceId");

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisputeMessage" ADD CONSTRAINT "DisputeMessage_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "Dispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowEvent" ADD CONSTRAINT "EscrowEvent_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

