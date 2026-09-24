-- CreateTable: ProductPriceVersion
CREATE TABLE "ProductPriceVersion" (
    "id"            TEXT NOT NULL,
    "productId"     TEXT NOT NULL,
    "priceUsdc"     DECIMAL(18,6) NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive"      BOOLEAN NOT NULL DEFAULT true,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductPriceVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductPriceVersion_productId_idx" ON "ProductPriceVersion"("productId");

-- CreateIndex
CREATE INDEX "ProductPriceVersion_productId_effectiveDate_idx" ON "ProductPriceVersion"("productId", "effectiveDate");

-- CreateIndex
CREATE INDEX "ProductPriceVersion_isActive_idx" ON "ProductPriceVersion"("isActive");

-- AddForeignKey
ALTER TABLE "ProductPriceVersion" ADD CONSTRAINT "ProductPriceVersion_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
