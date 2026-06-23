-- CreateTable: Project
CREATE TABLE "Project" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "title"       VARCHAR(200) NOT NULL,
    "description" TEXT,
    "clientName"  VARCHAR(200),
    "status"      VARCHAR(20) NOT NULL DEFAULT 'active',
    "archivedAt"  TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable: TaxRate
CREATE TABLE "TaxRate" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "name"        VARCHAR(100) NOT NULL,
    "description" VARCHAR(300),
    "rate"        DECIMAL(6,4) NOT NULL,
    "isDefault"   BOOLEAN NOT NULL DEFAULT false,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Project_userId_idx" ON "Project"("userId");
CREATE INDEX "Project_status_idx" ON "Project"("status");
CREATE INDEX "TaxRate_userId_idx" ON "TaxRate"("userId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaxRate" ADD CONSTRAINT "TaxRate_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
