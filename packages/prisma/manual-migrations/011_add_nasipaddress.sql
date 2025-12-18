-- Add nasipaddress column to Router table
ALTER TABLE "Router" ADD COLUMN IF NOT EXISTS "nasipaddress" TEXT;
