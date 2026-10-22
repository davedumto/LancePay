-- CreateTable
CREATE TABLE "SandboxSession" (
    "id" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "seed" VARCHAR(64) NOT NULL,
    "seedData" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SandboxSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SandboxSession_apiKeyId_status_idx" ON "SandboxSession"("apiKeyId", "status");

-- CreateIndex
CREATE INDEX "SandboxSession_status_expiresAt_idx" ON "SandboxSession"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "SandboxSession_userId_idx" ON "SandboxSession"("userId");

-- Single active sandbox per developer app (API key). Partial indexes are not
-- expressible in schema.prisma, so this lives only in the migration.
CREATE UNIQUE INDEX "SandboxSession_apiKeyId_active_key" ON "SandboxSession"("apiKeyId") WHERE "status" = 'active';

-- AddForeignKey
ALTER TABLE "SandboxSession" ADD CONSTRAINT "SandboxSession_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxSession" ADD CONSTRAINT "SandboxSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
