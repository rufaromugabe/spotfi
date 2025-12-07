/*
  Warnings:

  - The primary key for the `radacct` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `acctinputoctets` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `acctoutputoctets` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `acctsessiontime` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `acctstarttime` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `acctstoptime` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `accttotaloctets` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `acctuniqueid` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `callingstationid` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `framedipaddress` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `nasidentifier` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `nasipaddress` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `nasmacaddress` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `username` on the `radacct` table. All the data in the column will be lost.
  - You are about to alter the column `op` on the `radcheck` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(2)`.
  - You are about to alter the column `op` on the `radreply` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(2)`.
  - A unique constraint covering the columns `[AcctUniqueId]` on the table `radacct` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `AcctSessionId` to the `radacct` table without a default value. This is not possible if the table is not empty.
  - Added the required column `AcctUniqueId` to the `radacct` table without a default value. This is not possible if the table is not empty.
  - Added the required column `NASIPAddress` to the `radacct` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "radacct_acctstarttime_idx";

-- DropIndex
DROP INDEX "radacct_callingstationid_idx";

-- DropIndex
DROP INDEX "radacct_nasidentifier_idx";

-- DropIndex
DROP INDEX "radacct_nasipaddress_idx";

-- DropIndex
DROP INDEX "radacct_nasmacaddress_idx";

-- DropIndex
DROP INDEX "radacct_routerId_acctstarttime_idx";

-- AlterTable
ALTER TABLE "radacct" DROP CONSTRAINT "radacct_pkey",
DROP COLUMN "acctinputoctets",
DROP COLUMN "acctoutputoctets",
DROP COLUMN "acctsessiontime",
DROP COLUMN "acctstarttime",
DROP COLUMN "acctstoptime",
DROP COLUMN "accttotaloctets",
DROP COLUMN "acctuniqueid",
DROP COLUMN "callingstationid",
DROP COLUMN "framedipaddress",
DROP COLUMN "nasidentifier",
DROP COLUMN "nasipaddress",
DROP COLUMN "nasmacaddress",
DROP COLUMN "username",
ADD COLUMN     "AcctAuthentic" TEXT,
ADD COLUMN     "AcctInputOctets" BIGINT,
ADD COLUMN     "AcctInterval" BIGINT,
ADD COLUMN     "AcctOutputOctets" BIGINT,
ADD COLUMN     "AcctSessionId" TEXT NOT NULL,
ADD COLUMN     "AcctSessionTime" BIGINT,
ADD COLUMN     "AcctStartTime" TIMESTAMP(3),
ADD COLUMN     "AcctStopTime" TIMESTAMP(3),
ADD COLUMN     "AcctTerminateCause" TEXT,
ADD COLUMN     "AcctUniqueId" TEXT NOT NULL,
ADD COLUMN     "AcctUpdateTime" TIMESTAMP(3),
ADD COLUMN     "CalledStationId" TEXT,
ADD COLUMN     "CallingStationId" TEXT,
ADD COLUMN     "Class" TEXT,
ADD COLUMN     "ConnectInfo_Stop" TEXT,
ADD COLUMN     "ConnectInfo_start" TEXT,
ADD COLUMN     "DelegatedIPv6Prefix" TEXT,
ADD COLUMN     "FramedIPAddress" TEXT,
ADD COLUMN     "FramedIPv6Address" TEXT,
ADD COLUMN     "FramedIPv6Prefix" TEXT,
ADD COLUMN     "FramedInterfaceId" TEXT,
ADD COLUMN     "FramedProtocol" TEXT,
ADD COLUMN     "NASIPAddress" TEXT NOT NULL,
ADD COLUMN     "NASPortId" TEXT,
ADD COLUMN     "NASPortType" TEXT,
ADD COLUMN     "RadAcctId" BIGSERIAL NOT NULL,
ADD COLUMN     "Realm" TEXT,
ADD COLUMN     "ServiceType" TEXT,
ADD COLUMN     "UserName" TEXT,
ADD CONSTRAINT "radacct_pkey" PRIMARY KEY ("RadAcctId");

-- AlterTable
ALTER TABLE "radcheck" ALTER COLUMN "op" SET DEFAULT '==',
ALTER COLUMN "op" SET DATA TYPE VARCHAR(2),
ALTER COLUMN "Attribute" SET DEFAULT '';

-- AlterTable
ALTER TABLE "radreply" ALTER COLUMN "op" SET DATA TYPE VARCHAR(2);

-- CreateTable
CREATE TABLE "radgroupcheck" (
    "id" SERIAL NOT NULL,
    "GroupName" TEXT NOT NULL DEFAULT '',
    "Attribute" TEXT NOT NULL DEFAULT '',
    "op" VARCHAR(2) NOT NULL DEFAULT '==',
    "Value" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "radgroupcheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "radgroupreply" (
    "id" SERIAL NOT NULL,
    "GroupName" TEXT NOT NULL DEFAULT '',
    "Attribute" TEXT NOT NULL DEFAULT '',
    "op" VARCHAR(2) NOT NULL DEFAULT '=',
    "Value" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "radgroupreply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "radusergroup" (
    "id" SERIAL NOT NULL,
    "UserName" TEXT NOT NULL DEFAULT '',
    "GroupName" TEXT NOT NULL DEFAULT '',
    "priority" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "radusergroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "radpostauth" (
    "id" BIGSERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "pass" TEXT,
    "reply" TEXT,
    "CalledStationId" TEXT,
    "CallingStationId" TEXT,
    "authdate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "Class" TEXT,

    CONSTRAINT "radpostauth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nas" (
    "id" SERIAL NOT NULL,
    "nasname" TEXT NOT NULL,
    "shortname" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'other',
    "ports" INTEGER,
    "secret" TEXT NOT NULL,
    "server" TEXT,
    "community" TEXT,
    "description" TEXT,

    CONSTRAINT "nas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nasreload" (
    "NASIPAddress" TEXT NOT NULL,
    "ReloadTime" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nasreload_pkey" PRIMARY KEY ("NASIPAddress")
);

-- CreateIndex
CREATE INDEX "radgroupcheck_GroupName" ON "radgroupcheck"("GroupName", "Attribute");

-- CreateIndex
CREATE INDEX "radgroupreply_GroupName" ON "radgroupreply"("GroupName", "Attribute");

-- CreateIndex
CREATE INDEX "radusergroup_UserName" ON "radusergroup"("UserName");

-- CreateIndex
CREATE INDEX "radpostauth_username_idx" ON "radpostauth"("username");

-- CreateIndex
CREATE INDEX "radpostauth_class_idx" ON "radpostauth"("Class");

-- CreateIndex
CREATE INDEX "nas_nasname" ON "nas"("nasname");

-- CreateIndex
CREATE UNIQUE INDEX "radacct_AcctUniqueId_key" ON "radacct"("AcctUniqueId");

-- CreateIndex
CREATE INDEX "radacct_active_session_idx" ON "radacct"("AcctUniqueId");

-- CreateIndex
CREATE INDEX "radacct_bulk_close" ON "radacct"("NASIPAddress", "AcctStartTime");

-- CreateIndex
CREATE INDEX "radacct_start_user_idx" ON "radacct"("AcctStartTime", "UserName");

-- CreateIndex
CREATE INDEX "radacct_calss_idx" ON "radacct"("Class");

-- RenameIndex
ALTER INDEX "radcheck_UserName_Attribute_idx" RENAME TO "radcheck_UserName";

-- RenameIndex
ALTER INDEX "radreply_UserName_Attribute_idx" RENAME TO "radreply_UserName";
