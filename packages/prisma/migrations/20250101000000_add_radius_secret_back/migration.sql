-- AddColumn: radius_secret to routers table
-- This column was removed in migration 20251216000000_rename_radius_secret_to_uam_secret
-- but the schema requires both uam_secret and radius_secret columns

-- Add the radius_secret column if it doesn't exist
DO $$ 
BEGIN 
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'routers' AND column_name = 'radius_secret'
    ) THEN
        ALTER TABLE "routers" ADD COLUMN "radius_secret" TEXT;
        
        -- Create unique index for radius_secret
        CREATE UNIQUE INDEX IF NOT EXISTS "routers_radius_secret_key" ON "routers"("radius_secret");
        
        -- Optionally backfill from uam_secret if radius_secret is NULL
        -- This preserves existing data
        UPDATE "routers" 
        SET "radius_secret" = "uam_secret" 
        WHERE "radius_secret" IS NULL AND "uam_secret" IS NOT NULL;
    END IF;
END $$;

