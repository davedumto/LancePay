ALTER TABLE "UserSession" ADD COLUMN "providerSessionId" VARCHAR(255);

CREATE UNIQUE INDEX "UserSession_providerSessionId_key" ON "UserSession"("providerSessionId");