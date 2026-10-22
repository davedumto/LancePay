-- AlterTable
ALTER TABLE "PayoutBatch" ADD COLUMN "cancelledAt" TIMESTAMP(3),
ADD COLUMN "cancellationReason" TEXT,
ADD COLUMN "cancelledById" TEXT;
