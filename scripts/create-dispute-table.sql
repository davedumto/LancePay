-- Create Dispute table if it doesn't exist
CREATE TABLE IF NOT EXISTS "Dispute" (
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

-- Create DisputeMessage table if it doesn't exist
CREATE TABLE IF NOT EXISTS "DisputeMessage" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "senderType" TEXT NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisputeMessage_pkey" PRIMARY KEY ("id")
);

-- Create indexes if they don't exist
CREATE UNIQUE INDEX IF NOT EXISTS "Dispute_invoiceId_key" ON "Dispute"("invoiceId");
CREATE INDEX IF NOT EXISTS "Dispute_invoiceId_idx" ON "Dispute"("invoiceId");
CREATE INDEX IF NOT EXISTS "DisputeMessage_disputeId_idx" ON "DisputeMessage"("disputeId");

-- Add foreign keys if they don't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'Dispute_invoiceId_fkey'
    ) THEN
        ALTER TABLE "Dispute" 
        ADD CONSTRAINT "Dispute_invoiceId_fkey" 
        FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'DisputeMessage_disputeId_fkey'
    ) THEN
        ALTER TABLE "DisputeMessage" 
        ADD CONSTRAINT "DisputeMessage_disputeId_fkey" 
        FOREIGN KEY ("disputeId") REFERENCES "Dispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
