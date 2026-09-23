-- AlterTable: UserWebhook - add signing-secret rotation grace window
ALTER TABLE "UserWebhook" ADD COLUMN "previousSigningSecret" VARCHAR(255);
ALTER TABLE "UserWebhook" ADD COLUMN "signingSecretExpiresAt" TIMESTAMP(3);
