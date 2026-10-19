-- CreateTable
CREATE TABLE "PersistedQuery" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "hash" VARCHAR(64) NOT NULL,
    "query" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,
    "complexity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersistedQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "cohortRules" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImpersonationSession" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "justification" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImpersonationSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PersistedQuery_appId_hash_key" ON "PersistedQuery"("appId", "hash");
CREATE INDEX "PersistedQuery_appId_idx" ON "PersistedQuery"("appId");
CREATE INDEX "PersistedQuery_hash_idx" ON "PersistedQuery"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlag_key_key" ON "FeatureFlag"("key");
CREATE INDEX "FeatureFlag_key_idx" ON "FeatureFlag"("key");
CREATE INDEX "FeatureFlag_createdById_idx" ON "FeatureFlag"("createdById");
CREATE INDEX "FeatureFlag_archived_idx" ON "FeatureFlag"("archived");

-- CreateIndex
CREATE UNIQUE INDEX "ImpersonationSession_token_key" ON "ImpersonationSession"("token");
CREATE INDEX "ImpersonationSession_adminId_idx" ON "ImpersonationSession"("adminId");
CREATE INDEX "ImpersonationSession_targetUserId_idx" ON "ImpersonationSession"("targetUserId");
CREATE INDEX "ImpersonationSession_expiresAt_idx" ON "ImpersonationSession"("expiresAt");

-- AddForeignKey
ALTER TABLE "PersistedQuery" ADD CONSTRAINT "PersistedQuery_appId_fkey" FOREIGN KEY ("appId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureFlag" ADD CONSTRAINT "FeatureFlag_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImpersonationSession" ADD CONSTRAINT "ImpersonationSession_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImpersonationSession" ADD CONSTRAINT "ImpersonationSession_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
