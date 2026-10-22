-- AlterTable
ALTER TABLE "FeatureFlag" ADD COLUMN "rolloutPercentage" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "killed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "changeLog" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "FeatureFlagChange" (
    "id" TEXT NOT NULL,
    "featureFlagId" TEXT NOT NULL,
    "changedById" TEXT NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "priorConfig" JSONB NOT NULL,
    "newConfig" JSONB NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureFlagChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KillSwitch" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "subsystem" VARCHAR(100) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'disengaged',
    "incidentRef" VARCHAR(100),
    "beforeSnapshot" JSONB,
    "afterSnapshot" JSONB,
    "engagedAt" TIMESTAMP(3),
    "engagedById" TEXT,
    "disengagedAt" TIMESTAMP(3),
    "disengagedById" TEXT,
    "elapsedSeconds" INTEGER,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KillSwitch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "reference" VARCHAR(100) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "severity" VARCHAR(20) NOT NULL DEFAULT 'high',
    "createdById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FeatureFlagChange_featureFlagId_idx" ON "FeatureFlagChange"("featureFlagId");
CREATE INDEX "FeatureFlagChange_changedById_idx" ON "FeatureFlagChange"("changedById");

-- CreateIndex
CREATE UNIQUE INDEX "KillSwitch_key_key" ON "KillSwitch"("key");
CREATE INDEX "KillSwitch_key_idx" ON "KillSwitch"("key");
CREATE INDEX "KillSwitch_status_idx" ON "KillSwitch"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Incident_reference_key" ON "Incident"("reference");
CREATE INDEX "Incident_reference_idx" ON "Incident"("reference");
CREATE INDEX "Incident_status_idx" ON "Incident"("status");

-- AddForeignKey
ALTER TABLE "FeatureFlagChange" ADD CONSTRAINT "FeatureFlagChange_featureFlagId_fkey" FOREIGN KEY ("featureFlagId") REFERENCES "FeatureFlag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeatureFlagChange" ADD CONSTRAINT "FeatureFlagChange_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KillSwitch" ADD CONSTRAINT "KillSwitch_engagedById_fkey" FOREIGN KEY ("engagedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "KillSwitch" ADD CONSTRAINT "KillSwitch_disengagedById_fkey" FOREIGN KEY ("disengagedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
