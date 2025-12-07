-- AlterTable
ALTER TABLE "radacct" ADD COLUMN     "nasmacaddress" TEXT;

-- CreateIndex
CREATE INDEX "radacct_nasmacaddress_idx" ON "radacct"("nasmacaddress");
