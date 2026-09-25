-- AlterTable: CreditNote running applied total
ALTER TABLE "CreditNote" ADD COLUMN "appliedAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- Credit notes already marked "applied" before per-invoice tracking existed
-- are treated as fully consumed so they can never be applied a second time.
UPDATE "CreditNote" SET "appliedAmount" = "amount" WHERE "status" = 'applied';

-- Database-level guard: a credit note can never be over-applied, even by
-- concurrent writers.
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_appliedAmount_within_amount"
    CHECK ("appliedAmount" >= 0 AND "appliedAmount" <= "amount");

-- CreateTable: CreditNoteApplication
CREATE TABLE "CreditNoteApplication" (
    "id"           TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "invoiceId"    TEXT NOT NULL,
    "amount"       DECIMAL(10,2) NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNoteApplication_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CreditNoteApplication_amount_positive" CHECK ("amount" > 0)
);

-- CreateIndex
CREATE INDEX "CreditNoteApplication_creditNoteId_idx" ON "CreditNoteApplication"("creditNoteId");

-- CreateIndex
CREATE INDEX "CreditNoteApplication_invoiceId_idx" ON "CreditNoteApplication"("invoiceId");

-- AddForeignKey
ALTER TABLE "CreditNoteApplication" ADD CONSTRAINT "CreditNoteApplication_creditNoteId_fkey"
    FOREIGN KEY ("creditNoteId") REFERENCES "CreditNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteApplication" ADD CONSTRAINT "CreditNoteApplication_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: DiscountRedemption
CREATE TABLE "DiscountRedemption" (
    "id"         TEXT NOT NULL,
    "discountId" TEXT NOT NULL,
    "invoiceId"  TEXT NOT NULL,
    "status"     TEXT NOT NULL DEFAULT 'pending',
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscountRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DiscountRedemption_discountId_invoiceId_key" ON "DiscountRedemption"("discountId", "invoiceId");

-- CreateIndex
CREATE INDEX "DiscountRedemption_discountId_status_idx" ON "DiscountRedemption"("discountId", "status");

-- CreateIndex
CREATE INDEX "DiscountRedemption_invoiceId_idx" ON "DiscountRedemption"("invoiceId");

-- AddForeignKey
ALTER TABLE "DiscountRedemption" ADD CONSTRAINT "DiscountRedemption_discountId_fkey"
    FOREIGN KEY ("discountId") REFERENCES "Discount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountRedemption" ADD CONSTRAINT "DiscountRedemption_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: QuoteLineItem
CREATE TABLE "QuoteLineItem" (
    "id"          TEXT NOT NULL,
    "quoteId"     TEXT NOT NULL,
    "productId"   TEXT,
    "description" VARCHAR(500) NOT NULL,
    "quantity"    DECIMAL(10,2) NOT NULL,
    "unitPrice"   DECIMAL(10,2) NOT NULL,
    "position"    INTEGER NOT NULL DEFAULT 0,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuoteLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuoteLineItem_quoteId_idx" ON "QuoteLineItem"("quoteId");

-- CreateIndex
CREATE INDEX "QuoteLineItem_productId_idx" ON "QuoteLineItem"("productId");

-- AddForeignKey
ALTER TABLE "QuoteLineItem" ADD CONSTRAINT "QuoteLineItem_quoteId_fkey"
    FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
