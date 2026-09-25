-- The schema declares @@unique([userId]) on AccountDeletionRequest (one
-- deletion request per user) but the table was created with a plain index.

-- DropIndex
DROP INDEX IF EXISTS "AccountDeletionRequest_userId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "AccountDeletionRequest_userId_key" ON "AccountDeletionRequest"("userId");
