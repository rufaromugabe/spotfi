-- CreateTable
CREATE TABLE "radquota" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "quota_type" TEXT NOT NULL DEFAULT 'monthly',
    "max_octets" BIGINT NOT NULL,
    "used_octets" BIGINT NOT NULL DEFAULT 0,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "radquota_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "radquota_username_quota_type_period_start_key" ON "radquota"("username", "quota_type", "period_start");

-- CreateIndex
CREATE INDEX "radquota_username_idx" ON "radquota"("username");

-- CreateIndex
CREATE INDEX "radquota_period_idx" ON "radquota"("period_end");

