-- AlterTable: add per-account team seat limit
ALTER TABLE "User" ADD COLUMN "teamSeatLimit" INTEGER NOT NULL DEFAULT 5;

-- AlterTable: add effective-date range to tax rates
ALTER TABLE "TaxRate" ADD COLUMN "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "TaxRate" ADD COLUMN "effectiveTo" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "TaxRate_userId_name_effectiveFrom_idx" ON "TaxRate"("userId", "name", "effectiveFrom");
