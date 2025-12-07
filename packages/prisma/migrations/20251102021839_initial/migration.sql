-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'HOST');

-- CreateEnum
CREATE TYPE "RouterStatus" AS ENUM ('ONLINE', 'OFFLINE', 'ERROR');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('PENDING', 'PAID', 'OVERDUE', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'HOST',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "RouterStatus" NOT NULL DEFAULT 'OFFLINE',
    "lastSeen" TIMESTAMP(3),
    "totalUsage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "nasipaddress" TEXT,
    "location" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "routerId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "period" TIMESTAMP(3) NOT NULL,
    "usage" DOUBLE PRECISION NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "radacct" (
    "acctuniqueid" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "nasipaddress" TEXT NOT NULL,
    "routerId" TEXT,
    "acctstarttime" TIMESTAMP(3),
    "acctstoptime" TIMESTAMP(3),
    "acctsessiontime" BIGINT,
    "acctinputoctets" BIGINT NOT NULL DEFAULT 0,
    "acctoutputoctets" BIGINT NOT NULL DEFAULT 0,
    "accttotaloctets" BIGINT NOT NULL DEFAULT 0,
    "framedipaddress" TEXT,

    CONSTRAINT "radacct_pkey" PRIMARY KEY ("acctuniqueid")
);

-- CreateTable
CREATE TABLE "radcheck" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "attribute" TEXT NOT NULL DEFAULT 'Cleartext-Password',
    "op" TEXT NOT NULL DEFAULT ':=',
    "value" TEXT NOT NULL,

    CONSTRAINT "radcheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "radreply" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "attribute" TEXT NOT NULL,
    "op" TEXT NOT NULL DEFAULT '=',
    "value" TEXT NOT NULL,

    CONSTRAINT "radreply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "routers_token_key" ON "routers"("token");

-- CreateIndex
CREATE INDEX "radcheck_username_idx" ON "radcheck"("username");

-- CreateIndex
CREATE INDEX "radreply_username_idx" ON "radreply"("username");

-- AddForeignKey
ALTER TABLE "routers" ADD CONSTRAINT "routers_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_routerId_fkey" FOREIGN KEY ("routerId") REFERENCES "routers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "radacct" ADD CONSTRAINT "radacct_routerId_fkey" FOREIGN KEY ("routerId") REFERENCES "routers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
