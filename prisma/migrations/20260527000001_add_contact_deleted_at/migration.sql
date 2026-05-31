-- Add soft-delete support to Contact: add nullable deletedAt column
-- Existing rows remain fully visible (deletedAt IS NULL)
ALTER TABLE "Contact" ADD COLUMN "deletedAt" TIMESTAMP(3);
