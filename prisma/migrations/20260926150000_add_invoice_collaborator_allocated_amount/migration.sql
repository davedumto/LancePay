-- AlterTable: InvoiceCollaborator gains a persisted dollar allocation that
-- the allocations/rebalance endpoint keeps in sync with the invoice's
-- current total (sharePercentage stays the contractual split; this tracks
-- the actual amount owed against whatever the invoice total is right now).
ALTER TABLE "InvoiceCollaborator" ADD COLUMN "allocatedAmount" DECIMAL(10,2);
ALTER TABLE "InvoiceCollaborator" ADD COLUMN "rebalancedAt" TIMESTAMP(3);
