/*
  Warnings:

  - A unique constraint covering the columns `[radiusSecret]` on the table `routers` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "routers" ADD COLUMN     "radiusSecret" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "routers_radiusSecret_key" ON "routers"("radiusSecret");
