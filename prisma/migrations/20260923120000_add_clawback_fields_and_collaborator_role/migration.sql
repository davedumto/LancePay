-- AlterTable
ALTER TABLE "ReferralEarning" ADD COLUMN "clawbackReason" TEXT,
ADD COLUMN "clawbackAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "InvoiceCollaborator" ADD COLUMN "role" VARCHAR(20) NOT NULL DEFAULT 'viewer';
