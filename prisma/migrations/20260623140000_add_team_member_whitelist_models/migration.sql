-- CreateTable: TeamMember
CREATE TABLE "TeamMember" (
    "id"          TEXT NOT NULL,
    "ownerId"     TEXT NOT NULL,
    "memberId"    TEXT,
    "email"       VARCHAR(255) NOT NULL,
    "role"        VARCHAR(30) NOT NULL DEFAULT 'viewer',
    "status"      VARCHAR(20) NOT NULL DEFAULT 'pending',
    "invitedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt"  TIMESTAMP(3),
    "removedAt"   TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable: WhitelistAddress
CREATE TABLE "WhitelistAddress" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "label"     VARCHAR(100) NOT NULL,
    "address"   VARCHAR(70) NOT NULL,
    "network"   VARCHAR(20) NOT NULL DEFAULT 'stellar',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhitelistAddress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_ownerId_email_key" ON "TeamMember"("ownerId", "email");
CREATE INDEX "TeamMember_ownerId_idx" ON "TeamMember"("ownerId");
CREATE INDEX "TeamMember_memberId_idx" ON "TeamMember"("memberId");
CREATE UNIQUE INDEX "WhitelistAddress_userId_address_key" ON "WhitelistAddress"("userId", "address");
CREATE INDEX "WhitelistAddress_userId_idx" ON "WhitelistAddress"("userId");

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WhitelistAddress" ADD CONSTRAINT "WhitelistAddress_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
