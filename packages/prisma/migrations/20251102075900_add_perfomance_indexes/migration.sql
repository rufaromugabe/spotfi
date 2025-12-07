-- CreateIndex
CREATE INDEX "invoices_hostId_idx" ON "invoices"("hostId");

-- CreateIndex
CREATE INDEX "invoices_routerId_idx" ON "invoices"("routerId");

-- CreateIndex
CREATE INDEX "invoices_period_idx" ON "invoices"("period");

-- CreateIndex
CREATE INDEX "invoices_hostId_period_idx" ON "invoices"("hostId", "period");

-- CreateIndex
CREATE INDEX "radacct_routerId_idx" ON "radacct"("routerId");

-- CreateIndex
CREATE INDEX "radacct_nasipaddress_idx" ON "radacct"("nasipaddress");

-- CreateIndex
CREATE INDEX "radacct_acctstarttime_idx" ON "radacct"("acctstarttime");

-- CreateIndex
CREATE INDEX "radacct_routerId_acctstarttime_idx" ON "radacct"("routerId", "acctstarttime");

-- CreateIndex
CREATE INDEX "routers_hostId_idx" ON "routers"("hostId");
