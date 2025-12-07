/*
  Warnings:

  - A unique constraint covering the columns `[nasname]` on the table `nas` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[UserName,Attribute]` on the table `radcheck` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[GroupName,Attribute]` on the table `radgroupcheck` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[GroupName,Attribute]` on the table `radgroupreply` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[UserName,Attribute]` on the table `radreply` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[UserName,GroupName]` on the table `radusergroup` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "nas_nasname_key" ON "nas"("nasname");

-- CreateIndex
CREATE UNIQUE INDEX "radcheck_unique" ON "radcheck"("UserName", "Attribute");

-- CreateIndex
CREATE UNIQUE INDEX "radgroupcheck_unique" ON "radgroupcheck"("GroupName", "Attribute");

-- CreateIndex
CREATE UNIQUE INDEX "radgroupreply_unique" ON "radgroupreply"("GroupName", "Attribute");

-- CreateIndex
CREATE UNIQUE INDEX "radreply_unique" ON "radreply"("UserName", "Attribute");

-- CreateIndex
CREATE UNIQUE INDEX "radusergroup_unique" ON "radusergroup"("UserName", "GroupName");
