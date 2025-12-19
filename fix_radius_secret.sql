-- Quick fix: Add radius_secret column to routers table
-- Run this SQL directly on your database if you need an immediate fix

DO $$ 
BEGIN 
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'routers' AND column_name = 'radius_secret'
    ) THEN
        ALTER TABLE "routers" ADD COLUMN "radius_secret" TEXT;
        
        CREATE UNIQUE INDEX IF NOT EXISTS "routers_radius_secret_key" ON "routers"("radius_secret");
        
        -- Backfill from uam_secret if available
        UPDATE "routers" 
        SET "radius_secret" = "uam_secret" 
        WHERE "radius_secret" IS NULL AND "uam_secret" IS NOT NULL;
        
        RAISE NOTICE 'Column radius_secret added successfully';
    ELSE
        RAISE NOTICE 'Column radius_secret already exists';
    END IF;
END $$;

