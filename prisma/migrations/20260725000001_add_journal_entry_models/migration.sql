-- CreateTable: JournalEntry
CREATE TABLE "JournalEntry" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "memo"      TEXT,
    "status"    VARCHAR(20) NOT NULL DEFAULT 'posted',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable: JournalLine
CREATE TABLE "JournalLine" (
    "id"      TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "account" VARCHAR(100) NOT NULL,
    "debit"   DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit"  DECIMAL(18,2) NOT NULL DEFAULT 0,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JournalEntry_userId_idx" ON "JournalEntry"("userId");

-- CreateIndex
CREATE INDEX "JournalEntry_entryDate_idx" ON "JournalEntry"("entryDate");

-- CreateIndex
CREATE INDEX "JournalLine_entryId_idx" ON "JournalLine"("entryId");

-- CreateIndex
CREATE INDEX "JournalLine_account_idx" ON "JournalLine"("account");

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_entryId_fkey"
    FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
