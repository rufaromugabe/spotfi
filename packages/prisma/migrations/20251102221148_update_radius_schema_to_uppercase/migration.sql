/*
  Warnings:

  - You are about to drop the column `attribute` on the `radcheck` table. All the data in the column will be lost.
  - You are about to drop the column `username` on the `radcheck` table. All the data in the column will be lost.
  - You are about to drop the column `value` on the `radcheck` table. All the data in the column will be lost.
  - You are about to drop the column `attribute` on the `radreply` table. All the data in the column will be lost.
  - You are about to drop the column `username` on the `radreply` table. All the data in the column will be lost.
  - You are about to drop the column `value` on the `radreply` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "radcheck_username_idx";

-- DropIndex
DROP INDEX "radreply_username_idx";

-- AlterTable
ALTER TABLE "radcheck" DROP COLUMN "attribute",
DROP COLUMN "username",
DROP COLUMN "value",
ADD COLUMN     "Attribute" TEXT NOT NULL DEFAULT 'Cleartext-Password',
ADD COLUMN     "UserName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "Value" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "radreply" DROP COLUMN "attribute",
DROP COLUMN "username",
DROP COLUMN "value",
ADD COLUMN     "Attribute" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "UserName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "Value" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "radcheck_UserName_Attribute_idx" ON "radcheck"("UserName", "Attribute");

-- CreateIndex
CREATE INDEX "radreply_UserName_Attribute_idx" ON "radreply"("UserName", "Attribute");
