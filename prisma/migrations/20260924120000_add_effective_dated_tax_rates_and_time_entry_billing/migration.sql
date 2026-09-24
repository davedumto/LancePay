-- AlterTable: Project - add configured hourly rate
ALTER TABLE "Project" ADD COLUMN "rateUsdc" DECIMAL(18,6);

-- AlterTable: TimeEntry - link entries to a project
ALTER TABLE "TimeEntry" ADD COLUMN "projectId" TEXT;

-- CreateIndex
CREATE INDEX "TimeEntry_projectId_idx" ON "TimeEntry"("projectId");

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: TaxRate - effective dating, jurisdiction and compound-tax parent
ALTER TABLE "TaxRate" ADD COLUMN "jurisdiction" VARCHAR(100) NOT NULL DEFAULT '';
ALTER TABLE "TaxRate" ADD COLUMN "effectiveFrom" DATE NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE "TaxRate" ADD COLUMN "effectiveTo" DATE;
ALTER TABLE "TaxRate" ADD COLUMN "parentRateId" TEXT;

-- Drop the backfill defaults now that existing rows are populated
ALTER TABLE "TaxRate" ALTER COLUMN "jurisdiction" DROP DEFAULT;
ALTER TABLE "TaxRate" ALTER COLUMN "effectiveFrom" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "TaxRate_userId_jurisdiction_effectiveFrom_idx" ON "TaxRate"("userId", "jurisdiction", "effectiveFrom");
CREATE INDEX "TaxRate_parentRateId_idx" ON "TaxRate"("parentRateId");

-- AddForeignKey
ALTER TABLE "TaxRate" ADD CONSTRAINT "TaxRate_parentRateId_fkey"
    FOREIGN KEY ("parentRateId") REFERENCES "TaxRate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
