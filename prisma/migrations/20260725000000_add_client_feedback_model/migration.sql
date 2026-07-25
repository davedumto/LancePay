-- CreateTable: ClientFeedback
CREATE TABLE "ClientFeedback" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "clientId"  TEXT NOT NULL,
    "rating"    INTEGER NOT NULL,
    "comment"   TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientFeedback_userId_idx" ON "ClientFeedback"("userId");

-- CreateIndex
CREATE INDEX "ClientFeedback_clientId_idx" ON "ClientFeedback"("clientId");

-- CreateIndex
CREATE INDEX "ClientFeedback_createdAt_idx" ON "ClientFeedback"("createdAt");

-- AddForeignKey
ALTER TABLE "ClientFeedback" ADD CONSTRAINT "ClientFeedback_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientFeedback" ADD CONSTRAINT "ClientFeedback_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
