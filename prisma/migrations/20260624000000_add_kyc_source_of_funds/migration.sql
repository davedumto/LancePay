-- CreateTable
CREATE TABLE "KycSourceOfFunds" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceType" VARCHAR(50) NOT NULL,
    "annualIncome" DECIMAL(18,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "occupation" VARCHAR(100) NOT NULL,
    "companyName" VARCHAR(100),
    "supportingDocUrl" VARCHAR(512),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KycSourceOfFunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KycSourceOfFunds_userId_key" ON "KycSourceOfFunds"("userId");

-- AddForeignKey
ALTER TABLE "KycSourceOfFunds" ADD CONSTRAINT "KycSourceOfFunds_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
