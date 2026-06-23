-- Create ReminderSchedule table
CREATE TABLE "ReminderSchedule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "frequency" VARCHAR(20) NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "timezone" VARCHAR(50),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReminderSchedule_pkey" PRIMARY KEY ("id")
);

-- Create ClientNote table
CREATE TABLE "ClientNote" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientNote_pkey" PRIMARY KEY ("id")
);

-- Create SavedFilter table
CREATE TABLE "SavedFilter" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "entityType" VARCHAR(50) NOT NULL,
    "filters" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedFilter_pkey" PRIMARY KEY ("id")
);

-- Create indexes for ReminderSchedule
CREATE INDEX "ReminderSchedule_userId_idx" ON "ReminderSchedule"("userId");
CREATE INDEX "ReminderSchedule_enabled_idx" ON "ReminderSchedule"("enabled");
CREATE INDEX "ReminderSchedule_nextRunAt_idx" ON "ReminderSchedule"("nextRunAt");

-- Create indexes for ClientNote
CREATE INDEX "ClientNote_userId_idx" ON "ClientNote"("userId");
CREATE INDEX "ClientNote_clientId_idx" ON "ClientNote"("clientId");
CREATE INDEX "ClientNote_createdAt_idx" ON "ClientNote"("createdAt");

-- Create unique constraint and indexes for SavedFilter
CREATE UNIQUE INDEX "SavedFilter_userId_name_key" ON "SavedFilter"("userId", "name");
CREATE INDEX "SavedFilter_userId_idx" ON "SavedFilter"("userId");
CREATE INDEX "SavedFilter_entityType_idx" ON "SavedFilter"("entityType");

-- Add foreign key constraints
ALTER TABLE "ReminderSchedule"
ADD CONSTRAINT "ReminderSchedule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClientNote"
ADD CONSTRAINT "ClientNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClientNote"
ADD CONSTRAINT "ClientNote_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SavedFilter"
ADD CONSTRAINT "SavedFilter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
