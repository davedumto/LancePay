-- CreateTable
CREATE TABLE "SourceOfFundsDeclaration" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceType" VARCHAR(50) NOT NULL,
    "details" TEXT NOT NULL,
    "monthlyVolumeUsdc" DECIMAL(18,6),
    "annualIncomeUsdc" DECIMAL(18,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceOfFundsDeclaration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SourceOfFundsDeclaration_userId_key" ON "SourceOfFundsDeclaration"("userId");

-- CreateIndex
CREATE INDEX "SourceOfFundsDeclaration_sourceType_idx" ON "SourceOfFundsDeclaration"("sourceType");

-- AddForeignKey
ALTER TABLE "SourceOfFundsDeclaration" ADD CONSTRAINT "SourceOfFundsDeclaration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
