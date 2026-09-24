-- CreateTable
CREATE TABLE "UserWithdrawalBalance" (
    "userId" TEXT NOT NULL,
    "availableUsdc" DECIMAL(18,7) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserWithdrawalBalance_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "UserWithdrawalBalance" ADD CONSTRAINT "UserWithdrawalBalance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
