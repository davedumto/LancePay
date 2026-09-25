-- Add domain verification fields to BrandingSettings
ALTER TABLE "BrandingSettings" ADD COLUMN "customDomain" VARCHAR(255);
ALTER TABLE "BrandingSettings" ADD COLUMN "verificationToken" VARCHAR(255);
ALTER TABLE "BrandingSettings" ADD COLUMN "verificationStatus" VARCHAR(20) NOT NULL DEFAULT 'unverified';
ALTER TABLE "BrandingSettings" ADD COLUMN "verifiedAt" TIMESTAMP(3);
ALTER TABLE "BrandingSettings" ADD COLUMN "verificationAttempts" INTEGER NOT NULL DEFAULT 0;

-- Create index on customDomain for lookups
CREATE INDEX "BrandingSettings_customDomain_idx" ON "BrandingSettings"("customDomain");

-- Create index on verificationStatus for queries
CREATE INDEX "BrandingSettings_verificationStatus_idx" ON "BrandingSettings"("verificationStatus");
