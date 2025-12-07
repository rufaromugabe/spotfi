/*
  Warnings:

  - The primary key for the `nasreload` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `NASIPAddress` on the `nasreload` table. All the data in the column will be lost.
  - You are about to drop the column `ReloadTime` on the `nasreload` table. All the data in the column will be lost.
  - The primary key for the `radacct` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `AcctAuthentic` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `AcctInputOctets` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `AcctInterval` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `AcctOutputOctets` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `AcctSessionId` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `AcctSessionTime` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `AcctStartTime` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `AcctStopTime` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `AcctTerminateCause` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `AcctUniqueId` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `AcctUpdateTime` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `CalledStationId` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `CallingStationId` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `Class` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `ConnectInfo_Stop` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `ConnectInfo_start` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `DelegatedIPv6Prefix` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `FramedIPAddress` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `FramedIPv6Address` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `FramedIPv6Prefix` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `FramedInterfaceId` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `FramedProtocol` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `NASIPAddress` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `NASPortId` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `NASPortType` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `RadAcctId` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `Realm` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `ServiceType` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `UserName` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `Attribute` on the `radcheck` table. All the data in the column will be lost.
  - You are about to drop the column `UserName` on the `radcheck` table. All the data in the column will be lost.
  - You are about to drop the column `Value` on the `radcheck` table. All the data in the column will be lost.
  - You are about to drop the column `Attribute` on the `radgroupcheck` table. All the data in the column will be lost.
  - You are about to drop the column `GroupName` on the `radgroupcheck` table. All the data in the column will be lost.
  - You are about to drop the column `Value` on the `radgroupcheck` table. All the data in the column will be lost.
  - You are about to drop the column `Attribute` on the `radgroupreply` table. All the data in the column will be lost.
  - You are about to drop the column `GroupName` on the `radgroupreply` table. All the data in the column will be lost.
  - You are about to drop the column `Value` on the `radgroupreply` table. All the data in the column will be lost.
  - You are about to drop the column `CalledStationId` on the `radpostauth` table. All the data in the column will be lost.
  - You are about to drop the column `CallingStationId` on the `radpostauth` table. All the data in the column will be lost.
  - You are about to drop the column `Class` on the `radpostauth` table. All the data in the column will be lost.
  - You are about to drop the column `Attribute` on the `radreply` table. All the data in the column will be lost.
  - You are about to drop the column `UserName` on the `radreply` table. All the data in the column will be lost.
  - You are about to drop the column `Value` on the `radreply` table. All the data in the column will be lost.
  - You are about to drop the column `GroupName` on the `radusergroup` table. All the data in the column will be lost.
  - You are about to drop the column `UserName` on the `radusergroup` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[acctuniqueid]` on the table `radacct` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[username,attribute]` on the table `radcheck` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[groupname,attribute]` on the table `radgroupcheck` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[groupname,attribute]` on the table `radgroupreply` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[username,attribute]` on the table `radreply` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[username,groupname]` on the table `radusergroup` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `nasipaddress` to the `nasreload` table without a default value. This is not possible if the table is not empty.
  - Added the required column `reloadtime` to the `nasreload` table without a default value. This is not possible if the table is not empty.
  - Added the required column `acctsessionid` to the `radacct` table without a default value. This is not possible if the table is not empty.
  - Added the required column `acctuniqueid` to the `radacct` table without a default value. This is not possible if the table is not empty.
  - Added the required column `nasipaddress` to the `radacct` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "radacct_AcctUniqueId_key";

-- DropIndex
DROP INDEX "radacct_active_session_idx";

-- DropIndex
DROP INDEX "radacct_bulk_close";

-- DropIndex
DROP INDEX "radacct_calss_idx";

-- DropIndex
DROP INDEX "radacct_start_user_idx";

-- DropIndex
DROP INDEX "radcheck_UserName";

-- DropIndex
DROP INDEX "radcheck_unique";

-- DropIndex
DROP INDEX "radgroupcheck_GroupName";

-- DropIndex
DROP INDEX "radgroupcheck_unique";

-- DropIndex
DROP INDEX "radgroupreply_GroupName";

-- DropIndex
DROP INDEX "radgroupreply_unique";

-- DropIndex
DROP INDEX "radpostauth_class_idx";

-- DropIndex
DROP INDEX "radreply_UserName";

-- DropIndex
DROP INDEX "radreply_unique";

-- DropIndex
DROP INDEX "radusergroup_UserName";

-- DropIndex
DROP INDEX "radusergroup_unique";

-- AlterTable
ALTER TABLE "nasreload" DROP CONSTRAINT "nasreload_pkey",
DROP COLUMN "NASIPAddress",
DROP COLUMN "ReloadTime",
ADD COLUMN     "nasipaddress" TEXT NOT NULL,
ADD COLUMN     "reloadtime" TIMESTAMP(3) NOT NULL,
ADD CONSTRAINT "nasreload_pkey" PRIMARY KEY ("nasipaddress");

-- AlterTable
ALTER TABLE "radacct" DROP CONSTRAINT "radacct_pkey",
DROP COLUMN "AcctAuthentic",
DROP COLUMN "AcctInputOctets",
DROP COLUMN "AcctInterval",
DROP COLUMN "AcctOutputOctets",
DROP COLUMN "AcctSessionId",
DROP COLUMN "AcctSessionTime",
DROP COLUMN "AcctStartTime",
DROP COLUMN "AcctStopTime",
DROP COLUMN "AcctTerminateCause",
DROP COLUMN "AcctUniqueId",
DROP COLUMN "AcctUpdateTime",
DROP COLUMN "CalledStationId",
DROP COLUMN "CallingStationId",
DROP COLUMN "Class",
DROP COLUMN "ConnectInfo_Stop",
DROP COLUMN "ConnectInfo_start",
DROP COLUMN "DelegatedIPv6Prefix",
DROP COLUMN "FramedIPAddress",
DROP COLUMN "FramedIPv6Address",
DROP COLUMN "FramedIPv6Prefix",
DROP COLUMN "FramedInterfaceId",
DROP COLUMN "FramedProtocol",
DROP COLUMN "NASIPAddress",
DROP COLUMN "NASPortId",
DROP COLUMN "NASPortType",
DROP COLUMN "RadAcctId",
DROP COLUMN "Realm",
DROP COLUMN "ServiceType",
DROP COLUMN "UserName",
ADD COLUMN     "acctauthentic" TEXT,
ADD COLUMN     "acctinputoctets" BIGINT,
ADD COLUMN     "acctinterval" BIGINT,
ADD COLUMN     "acctoutputoctets" BIGINT,
ADD COLUMN     "acctsessionid" TEXT NOT NULL,
ADD COLUMN     "acctsessiontime" BIGINT,
ADD COLUMN     "acctstarttime" TIMESTAMP(3),
ADD COLUMN     "acctstoptime" TIMESTAMP(3),
ADD COLUMN     "acctterminatecause" TEXT,
ADD COLUMN     "acctuniqueid" TEXT NOT NULL,
ADD COLUMN     "acctupdatetime" TIMESTAMP(3),
ADD COLUMN     "calledstationid" TEXT,
ADD COLUMN     "callingstationid" TEXT,
ADD COLUMN     "class" TEXT,
ADD COLUMN     "connectinfo_start" TEXT,
ADD COLUMN     "connectinfo_stop" TEXT,
ADD COLUMN     "delegatedipv6prefix" TEXT,
ADD COLUMN     "framedinterfaceid" TEXT,
ADD COLUMN     "framedipaddress" TEXT,
ADD COLUMN     "framedipv6address" TEXT,
ADD COLUMN     "framedipv6prefix" TEXT,
ADD COLUMN     "framedprotocol" TEXT,
ADD COLUMN     "nasipaddress" TEXT NOT NULL,
ADD COLUMN     "nasportid" TEXT,
ADD COLUMN     "nasporttype" TEXT,
ADD COLUMN     "radacctid" BIGSERIAL NOT NULL,
ADD COLUMN     "realm" TEXT,
ADD COLUMN     "servicetype" TEXT,
ADD COLUMN     "username" TEXT,
ADD CONSTRAINT "radacct_pkey" PRIMARY KEY ("radacctid");

-- AlterTable
ALTER TABLE "radcheck" DROP COLUMN "Attribute",
DROP COLUMN "UserName",
DROP COLUMN "Value",
ADD COLUMN     "attribute" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "username" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "value" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "radgroupcheck" DROP COLUMN "Attribute",
DROP COLUMN "GroupName",
DROP COLUMN "Value",
ADD COLUMN     "attribute" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "groupname" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "value" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "radgroupreply" DROP COLUMN "Attribute",
DROP COLUMN "GroupName",
DROP COLUMN "Value",
ADD COLUMN     "attribute" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "groupname" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "value" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "radpostauth" DROP COLUMN "CalledStationId",
DROP COLUMN "CallingStationId",
DROP COLUMN "Class",
ADD COLUMN     "calledstationid" TEXT,
ADD COLUMN     "callingstationid" TEXT,
ADD COLUMN     "class" TEXT;

-- AlterTable
ALTER TABLE "radreply" DROP COLUMN "Attribute",
DROP COLUMN "UserName",
DROP COLUMN "Value",
ADD COLUMN     "attribute" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "username" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "value" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "radusergroup" DROP COLUMN "GroupName",
DROP COLUMN "UserName",
ADD COLUMN     "groupname" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "username" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE UNIQUE INDEX "radacct_acctuniqueid_key" ON "radacct"("acctuniqueid");

-- CreateIndex
CREATE INDEX "radacct_active_session_idx" ON "radacct"("acctuniqueid");

-- CreateIndex
CREATE INDEX "radacct_bulk_close" ON "radacct"("nasipaddress", "acctstarttime");

-- CreateIndex
CREATE INDEX "radacct_start_user_idx" ON "radacct"("acctstarttime", "username");

-- CreateIndex
CREATE INDEX "radacct_calss_idx" ON "radacct"("class");

-- CreateIndex
CREATE INDEX "radcheck_username" ON "radcheck"("username", "attribute");

-- CreateIndex
CREATE UNIQUE INDEX "radcheck_unique" ON "radcheck"("username", "attribute");

-- CreateIndex
CREATE INDEX "radgroupcheck_groupname" ON "radgroupcheck"("groupname", "attribute");

-- CreateIndex
CREATE UNIQUE INDEX "radgroupcheck_unique" ON "radgroupcheck"("groupname", "attribute");

-- CreateIndex
CREATE INDEX "radgroupreply_groupname" ON "radgroupreply"("groupname", "attribute");

-- CreateIndex
CREATE UNIQUE INDEX "radgroupreply_unique" ON "radgroupreply"("groupname", "attribute");

-- CreateIndex
CREATE INDEX "radpostauth_class_idx" ON "radpostauth"("class");

-- CreateIndex
CREATE INDEX "radreply_username" ON "radreply"("username", "attribute");

-- CreateIndex
CREATE UNIQUE INDEX "radreply_unique" ON "radreply"("username", "attribute");

-- CreateIndex
CREATE INDEX "radusergroup_username" ON "radusergroup"("username");

-- CreateIndex
CREATE UNIQUE INDEX "radusergroup_unique" ON "radusergroup"("username", "groupname");
