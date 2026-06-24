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
CREATE UNIQUE INDEX "WhitelistAddress_userId_address_key" ON "WhitelistAddress"("userId", "address");
CREATE INDEX "WhitelistAddress_userId_idx" ON "WhitelistAddress"("userId");

-- AddForeignKey
ALTER TABLE "WhitelistAddress" ADD CONSTRAINT "WhitelistAddress_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
