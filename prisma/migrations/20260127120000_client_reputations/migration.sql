-- CreateTable
CREATE TABLE "client_reputations" (
    "id" TEXT NOT NULL,
    "client_email" TEXT NOT NULL,
    "domain_type" TEXT,
    "payment_score" INTEGER NOT NULL DEFAULT 0,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "last_checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_reputations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_reputations_client_email_key" ON "client_reputations"("client_email");

-- CreateIndex
CREATE INDEX "client_reputations_client_email_idx" ON "client_reputations"("client_email");
