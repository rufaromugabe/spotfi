/*
  Warnings:

  - The primary key for the `nasreload` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `nasipaddress` on the `nasreload` table. All the data in the column will be lost.
  - You are about to drop the column `reloadtime` on the `nasreload` table. All the data in the column will be lost.
  - The primary key for the `radacct` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `acctauthentic` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `acctinputoctets` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `acctinterval` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `acctoutputoctets` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `acctsessionid` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `acctsessiontime` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `acctstarttime` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `acctstoptime` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `acctterminatecause` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `acctuniqueid` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `acctupdatetime` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `calledstationid` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `callingstationid` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `class` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `connectinfo_start` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `connectinfo_stop` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `delegatedipv6prefix` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `framedinterfaceid` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `framedipaddress` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `framedipv6address` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `framedipv6prefix` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `framedprotocol` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `nasipaddress` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `nasportid` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `nasporttype` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `radacctid` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `realm` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `servicetype` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `username` on the `radacct` table. All the data in the column will be lost.
  - You are about to drop the column `attribute` on the `radcheck` table. All the data in the column will be lost.
  - You are about to drop the column `username` on the `radcheck` table. All the data in the column will be lost.
  - You are about to drop the column `value` on the `radcheck` table. All the data in the column will be lost.
  - You are about to drop the column `attribute` on the `radgroupcheck` table. All the data in the column will be lost.
  - You are about to drop the column `groupname` on the `radgroupcheck` table. All the data in the column will be lost.
  - You are about to drop the column `value` on the `radgroupcheck` table. All the data in the column will be lost.
  - You are about to drop the column `attribute` on the `radgroupreply` table. All the data in the column will be lost.
  - You are about to drop the column `groupname` on the `radgroupreply` table. All the data in the column will be lost.
  - You are about to drop the column `value` on the `radgroupreply` table. All the data in the column will be lost.
  - You are about to drop the column `calledstationid` on the `radpostauth` table. All the data in the column will be lost.
  - You are about to drop the column `callingstationid` on the `radpostauth` table. All the data in the column will be lost.
  - You are about to drop the column `class` on the `radpostauth` table. All the data in the column will be lost.
  - You are about to drop the column `attribute` on the `radreply` table. All the data in the column will be lost.
  - You are about to drop the column `username` on the `radreply` table. All the data in the column will be lost.
  - You are about to drop the column `value` on the `radreply` table. All the data in the column will be lost.
  - You are about to drop the column `groupname` on the `radusergroup` table. All the data in the column will be lost.
  - You are about to drop the column `username` on the `radusergroup` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[AcctUniqueId]` on the table `radacct` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[UserName,Attribute]` on the table `radcheck` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[GroupName,Attribute]` on the table `radgroupcheck` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[GroupName,Attribute]` on the table `radgroupreply` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[UserName,Attribute]` on the table `radreply` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[UserName,GroupName]` on the table `radusergroup` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `NASIPAddress` to the `nasreload` table without a default value. This is not possible if the table is not empty.
  - Added the required column `ReloadTime` to the `nasreload` table without a default value. This is not possible if the table is not empty.
  - Added the required column `AcctSessionId` to the `radacct` table without a default value. This is not possible if the table is not empty.
  - Added the required column `AcctUniqueId` to the `radacct` table without a default value. This is not possible if the table is not empty.
  - Added the required column `NASIPAddress` to the `radacct` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "radacct_acctuniqueid_key";

-- DropIndex
DROP INDEX "radacct_active_session_idx";

-- DropIndex
DROP INDEX "radacct_bulk_close";

-- DropIndex
DROP INDEX "radacct_calss_idx";

-- DropIndex
DROP INDEX "radacct_start_user_idx";

-- DropIndex
DROP INDEX "radcheck_unique";

-- DropIndex
DROP INDEX "radcheck_username";

-- DropIndex
DROP INDEX "radgroupcheck_groupname";

-- DropIndex
DROP INDEX "radgroupcheck_unique";

-- DropIndex
DROP INDEX "radgroupreply_groupname";

-- DropIndex
DROP INDEX "radgroupreply_unique";

-- DropIndex
DROP INDEX "radpostauth_class_idx";

-- DropIndex
DROP INDEX "radreply_unique";

-- DropIndex
DROP INDEX "radreply_username";

-- DropIndex
DROP INDEX "radusergroup_unique";

-- DropIndex
DROP INDEX "radusergroup_username";

-- AlterTable
ALTER TABLE "nasreload" DROP CONSTRAINT "nasreload_pkey",
DROP COLUMN "nasipaddress",
DROP COLUMN "reloadtime",
ADD COLUMN     "NASIPAddress" TEXT NOT NULL,
ADD COLUMN     "ReloadTime" TIMESTAMP(3) NOT NULL,
ADD CONSTRAINT "nasreload_pkey" PRIMARY KEY ("NASIPAddress");

-- AlterTable
ALTER TABLE "radacct" DROP CONSTRAINT "radacct_pkey",
DROP COLUMN "acctauthentic",
DROP COLUMN "acctinputoctets",
DROP COLUMN "acctinterval",
DROP COLUMN "acctoutputoctets",
DROP COLUMN "acctsessionid",
DROP COLUMN "acctsessiontime",
DROP COLUMN "acctstarttime",
DROP COLUMN "acctstoptime",
DROP COLUMN "acctterminatecause",
DROP COLUMN "acctuniqueid",
DROP COLUMN "acctupdatetime",
DROP COLUMN "calledstationid",
DROP COLUMN "callingstationid",
DROP COLUMN "class",
DROP COLUMN "connectinfo_start",
DROP COLUMN "connectinfo_stop",
DROP COLUMN "delegatedipv6prefix",
DROP COLUMN "framedinterfaceid",
DROP COLUMN "framedipaddress",
DROP COLUMN "framedipv6address",
DROP COLUMN "framedipv6prefix",
DROP COLUMN "framedprotocol",
DROP COLUMN "nasipaddress",
DROP COLUMN "nasportid",
DROP COLUMN "nasporttype",
DROP COLUMN "radacctid",
DROP COLUMN "realm",
DROP COLUMN "servicetype",
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
ALTER TABLE "radcheck" DROP COLUMN "attribute",
DROP COLUMN "username",
DROP COLUMN "value",
ADD COLUMN     "Attribute" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "UserName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "Value" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "radgroupcheck" DROP COLUMN "attribute",
DROP COLUMN "groupname",
DROP COLUMN "value",
ADD COLUMN     "Attribute" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "GroupName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "Value" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "radgroupreply" DROP COLUMN "attribute",
DROP COLUMN "groupname",
DROP COLUMN "value",
ADD COLUMN     "Attribute" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "GroupName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "Value" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "radpostauth" DROP COLUMN "calledstationid",
DROP COLUMN "callingstationid",
DROP COLUMN "class",
ADD COLUMN     "CalledStationId" TEXT,
ADD COLUMN     "CallingStationId" TEXT,
ADD COLUMN     "Class" TEXT;

-- AlterTable
ALTER TABLE "radreply" DROP COLUMN "attribute",
DROP COLUMN "username",
DROP COLUMN "value",
ADD COLUMN     "Attribute" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "UserName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "Value" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "radusergroup" DROP COLUMN "groupname",
DROP COLUMN "username",
ADD COLUMN     "GroupName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "UserName" TEXT NOT NULL DEFAULT '';

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

-- CreateIndex
CREATE INDEX "radcheck_UserName" ON "radcheck"("UserName", "Attribute");

-- CreateIndex
CREATE UNIQUE INDEX "radcheck_unique" ON "radcheck"("UserName", "Attribute");

-- CreateIndex
CREATE INDEX "radgroupcheck_GroupName" ON "radgroupcheck"("GroupName", "Attribute");

-- CreateIndex
CREATE UNIQUE INDEX "radgroupcheck_unique" ON "radgroupcheck"("GroupName", "Attribute");

-- CreateIndex
CREATE INDEX "radgroupreply_GroupName" ON "radgroupreply"("GroupName", "Attribute");

-- CreateIndex
CREATE UNIQUE INDEX "radgroupreply_unique" ON "radgroupreply"("GroupName", "Attribute");

-- CreateIndex
CREATE INDEX "radpostauth_class_idx" ON "radpostauth"("Class");

-- CreateIndex
CREATE INDEX "radreply_UserName" ON "radreply"("UserName", "Attribute");

-- CreateIndex
CREATE UNIQUE INDEX "radreply_unique" ON "radreply"("UserName", "Attribute");

-- CreateIndex
CREATE INDEX "radusergroup_UserName" ON "radusergroup"("UserName");

-- CreateIndex
CREATE UNIQUE INDEX "radusergroup_unique" ON "radusergroup"("UserName", "GroupName");
