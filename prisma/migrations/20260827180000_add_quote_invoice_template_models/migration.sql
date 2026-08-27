-- CreateTable: Quote
CREATE TABLE "Quote" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "clientEmail" TEXT NOT NULL,
    "clientName"  TEXT,
    "description" TEXT NOT NULL,
    "amount"      DECIMAL(10,2) NOT NULL,
    "currency"    TEXT NOT NULL DEFAULT 'USD',
    "status"      TEXT NOT NULL DEFAULT 'pending',
    "expiresAt"   TIMESTAMP(3),
    "invoiceId"   TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Quote_invoiceId_key" ON "Quote"("invoiceId");

-- CreateIndex
CREATE INDEX "Quote_userId_idx" ON "Quote"("userId");

-- CreateIndex
CREATE INDEX "Quote_status_idx" ON "Quote"("status");

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: InvoiceTemplate
CREATE TABLE "InvoiceTemplate" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "clientEmail" TEXT,
    "clientName"  TEXT,
    "description" TEXT NOT NULL,
    "amount"      DECIMAL(10,2) NOT NULL,
    "currency"    TEXT NOT NULL DEFAULT 'USD',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceTemplate_userId_name_key" ON "InvoiceTemplate"("userId", "name");

-- CreateIndex
CREATE INDEX "InvoiceTemplate_userId_idx" ON "InvoiceTemplate"("userId");

-- AddForeignKey
ALTER TABLE "InvoiceTemplate" ADD CONSTRAINT "InvoiceTemplate_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
