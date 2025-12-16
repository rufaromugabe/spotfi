-- RenameColumn: radiusSecret -> uam_secret
ALTER TABLE "routers" RENAME COLUMN "radiusSecret" TO "uam_secret";

-- DropIndex
DROP INDEX IF EXISTS "routers_radiusSecret_key";

-- CreateIndex
CREATE UNIQUE INDEX "routers_uam_secret_key" ON "routers"("uam_secret");

