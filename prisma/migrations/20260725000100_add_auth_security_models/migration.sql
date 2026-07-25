-- AlterTable: User — add optional password hash for secondary credential flows
ALTER TABLE "User" ADD COLUMN "passwordHash" VARCHAR(255);

-- CreateTable: TrustedDevice
CREATE TABLE "TrustedDevice" (
    "id"         TEXT NOT NULL,
    "userId"     TEXT NOT NULL,
    "label"      VARCHAR(100) NOT NULL,
    "userAgent"  VARCHAR(500),
    "ipAddress"  VARCHAR(45),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrustedDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable: PasswordResetToken
CREATE TABLE "PasswordResetToken" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt"    TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable: RecoveryEmail
CREATE TABLE "RecoveryEmail" (
    "id"             TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    "email"          VARCHAR(255) NOT NULL,
    "tokenHash"      TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "verifiedAt"     TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecoveryEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ApiKeyIpAllowlist
CREATE TABLE "ApiKeyIpAllowlist" (
    "id"        TEXT NOT NULL,
    "apiKeyId"  TEXT NOT NULL,
    "cidr"      VARCHAR(50) NOT NULL,
    "label"     VARCHAR(100),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKeyIpAllowlist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrustedDevice_userId_idx" ON "TrustedDevice"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryEmail_userId_key" ON "RecoveryEmail"("userId");

-- CreateIndex
CREATE INDEX "RecoveryEmail_userId_idx" ON "RecoveryEmail"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKeyIpAllowlist_apiKeyId_cidr_key" ON "ApiKeyIpAllowlist"("apiKeyId", "cidr");

-- CreateIndex
CREATE INDEX "ApiKeyIpAllowlist_apiKeyId_idx" ON "ApiKeyIpAllowlist"("apiKeyId");

-- AddForeignKey
ALTER TABLE "TrustedDevice" ADD CONSTRAINT "TrustedDevice_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryEmail" ADD CONSTRAINT "RecoveryEmail_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKeyIpAllowlist" ADD CONSTRAINT "ApiKeyIpAllowlist_apiKeyId_fkey"
    FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
