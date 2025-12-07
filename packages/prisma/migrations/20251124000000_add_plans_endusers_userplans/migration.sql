-- CreateEnum (if not exists)
DO $$ BEGIN
    CREATE TYPE "EndUserStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED', 'EXPIRED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "PlanStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "UserPlanStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'CANCELLED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "QuotaType" AS ENUM ('MONTHLY', 'DAILY', 'WEEKLY', 'ONE_TIME');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateTable: end_users (if not exists)
CREATE TABLE IF NOT EXISTS "end_users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "full_name" TEXT,
    "status" "EndUserStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdById" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "end_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable: plans (if not exists)
CREATE TABLE IF NOT EXISTS "plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "data_quota" BIGINT,
    "quota_type" "QuotaType" NOT NULL DEFAULT 'MONTHLY',
    "max_upload_speed" BIGINT,
    "max_download_speed" BIGINT,
    "session_timeout" INTEGER,
    "idle_timeout" INTEGER,
    "max_sessions" INTEGER DEFAULT 1,
    "validity_days" INTEGER,
    "status" "PlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable: user_plans (if not exists)
CREATE TABLE IF NOT EXISTS "user_plans" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "status" "UserPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "data_used" BIGINT NOT NULL DEFAULT 0,
    "data_quota" BIGINT,
    "auto_renew" BOOLEAN NOT NULL DEFAULT false,
    "renewal_plan_id" TEXT,
    "assigned_by_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (if not exists)
CREATE INDEX IF NOT EXISTS "end_users_username_idx" ON "end_users"("username");
CREATE INDEX IF NOT EXISTS "end_users_status_idx" ON "end_users"("status");
CREATE INDEX IF NOT EXISTS "end_users_createdById_idx" ON "end_users"("createdById");
CREATE UNIQUE INDEX IF NOT EXISTS "end_users_username_key" ON "end_users"("username");

CREATE INDEX IF NOT EXISTS "plans_status_idx" ON "plans"("status");
CREATE INDEX IF NOT EXISTS "plans_is_default_idx" ON "plans"("is_default");

CREATE INDEX IF NOT EXISTS "user_plans_user_id_status_idx" ON "user_plans"("user_id", "status");
CREATE INDEX IF NOT EXISTS "user_plans_plan_id_idx" ON "user_plans"("plan_id");
CREATE INDEX IF NOT EXISTS "user_plans_expires_at_idx" ON "user_plans"("expires_at");
CREATE INDEX IF NOT EXISTS "user_plans_status_expires_at_idx" ON "user_plans"("status", "expires_at");

-- AddForeignKey (if not exists)
DO $$ BEGIN
    ALTER TABLE "user_plans" ADD CONSTRAINT "user_plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "end_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "user_plans" ADD CONSTRAINT "user_plans_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "user_plans" ADD CONSTRAINT "user_plans_renewal_plan_id_fkey" FOREIGN KEY ("renewal_plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

