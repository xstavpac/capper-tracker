-- Drop stav_incoming_catalog, the raw-text landing table for the retired
-- `ingest-picks` Supabase Edge Function (deleted 2026-11-02). The table is not in
-- schema.prisma. It held 3 TEST rows, archived locally before this migration.
-- IF EXISTS makes this a no-op where the table is absent (local dev, CI).
DROP TABLE IF EXISTS public.stav_incoming_catalog;
