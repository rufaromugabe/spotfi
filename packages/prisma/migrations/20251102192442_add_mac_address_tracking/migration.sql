-- AlterTable
ALTER TABLE "radacct" ADD COLUMN     "callingstationid" TEXT,
ADD COLUMN     "nasidentifier" TEXT;

-- AlterTable
ALTER TABLE "routers" ADD COLUMN     "macAddress" TEXT;

-- CreateIndex
CREATE INDEX "radacct_nasidentifier_idx" ON "radacct"("nasidentifier");

-- CreateIndex
CREATE INDEX "radacct_callingstationid_idx" ON "radacct"("callingstationid");

-- CreateIndex
CREATE INDEX "routers_macAddress_idx" ON "routers"("macAddress");
