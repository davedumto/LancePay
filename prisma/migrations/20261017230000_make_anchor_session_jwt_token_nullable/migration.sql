-- AlterTable: make AnchorSession.jwtToken nullable so session termination can set jwtToken = NULL
ALTER TABLE "AnchorSession" ALTER COLUMN "jwtToken" DROP NOT NULL;
