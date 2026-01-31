-- CreateTable
CREATE TABLE "manual_payments" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "client_name" VARCHAR(100) NOT NULL,
    "amount_paid" DECIMAL(18,6) NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'NGN',
    "receipt_url" VARCHAR(512) NOT NULL,
    "notes" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "verified_by" TEXT,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manual_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "manual_payments_invoice_id_idx" ON "manual_payments"("invoice_id");

-- CreateIndex
CREATE INDEX "manual_payments_status_idx" ON "manual_payments"("status");

-- CreateIndex
CREATE INDEX "manual_payments_created_at_idx" ON "manual_payments"("created_at");

-- AddForeignKey
ALTER TABLE "manual_payments" ADD CONSTRAINT "manual_payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_payments" ADD CONSTRAINT "manual_payments_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "payout_batches" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "total_amount" DECIMAL(18,6) NOT NULL,
    "item_count" INTEGER NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'processing',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payout_batches_user_id_idx" ON "payout_batches"("user_id");

-- CreateIndex
CREATE INDEX "payout_batches_status_idx" ON "payout_batches"("status");

-- AddForeignKey
ALTER TABLE "payout_batches" ADD CONSTRAINT "payout_batches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "payout_items" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "recipient_identifier" VARCHAR(255) NOT NULL,
    "amount" DECIMAL(18,6) NOT NULL,
    "payout_type" VARCHAR(30) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "tx_hash" VARCHAR(255),
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payout_items_batch_id_idx" ON "payout_items"("batch_id");

-- CreateIndex
CREATE INDEX "payout_items_status_idx" ON "payout_items"("status");

-- AddForeignKey
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "payout_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "collective_wallets" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "threshold" INTEGER NOT NULL DEFAULT 2,
    "stellar_address" VARCHAR(56) NOT NULL,
    "encrypted_secret_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collective_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "collective_wallets_stellar_address_key" ON "collective_wallets"("stellar_address");

-- CreateTable
CREATE TABLE "wallet_signers" (
    "id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_signers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_signers_wallet_id_user_id_key" ON "wallet_signers"("wallet_id", "user_id");

-- CreateIndex
CREATE INDEX "wallet_signers_wallet_id_idx" ON "wallet_signers"("wallet_id");

-- CreateIndex
CREATE INDEX "wallet_signers_user_id_idx" ON "wallet_signers"("user_id");

-- AddForeignKey
ALTER TABLE "wallet_signers" ADD CONSTRAINT "wallet_signers_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "collective_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_signers" ADD CONSTRAINT "wallet_signers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "multisig_proposals" (
    "id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "proposer_id" TEXT NOT NULL,
    "destination_address" VARCHAR(255) NOT NULL,
    "amount_usdc" DECIMAL(18,6) NOT NULL,
    "memo" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "executed_at" TIMESTAMP(3),
    "execution_started_at" TIMESTAMP(3),
    "stellar_tx_hash" VARCHAR(255),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "multisig_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "multisig_proposals_wallet_id_idx" ON "multisig_proposals"("wallet_id");

-- CreateIndex
CREATE INDEX "multisig_proposals_proposer_id_idx" ON "multisig_proposals"("proposer_id");

-- CreateIndex
CREATE INDEX "multisig_proposals_status_idx" ON "multisig_proposals"("status");

-- CreateIndex
CREATE INDEX "multisig_proposals_expires_at_idx" ON "multisig_proposals"("expires_at");

-- AddForeignKey
ALTER TABLE "multisig_proposals" ADD CONSTRAINT "multisig_proposals_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "collective_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "multisig_proposals" ADD CONSTRAINT "multisig_proposals_proposer_id_fkey" FOREIGN KEY ("proposer_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "proposal_signatures" (
    "id" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "signer_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposal_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "proposal_signatures_proposal_id_signer_id_key" ON "proposal_signatures"("proposal_id", "signer_id");

-- CreateIndex
CREATE INDEX "proposal_signatures_proposal_id_idx" ON "proposal_signatures"("proposal_id");

-- CreateIndex
CREATE INDEX "proposal_signatures_signer_id_idx" ON "proposal_signatures"("signer_id");

-- AddForeignKey
ALTER TABLE "proposal_signatures" ADD CONSTRAINT "proposal_signatures_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "multisig_proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_signatures" ADD CONSTRAINT "proposal_signatures_signer_id_fkey" FOREIGN KEY ("signer_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

