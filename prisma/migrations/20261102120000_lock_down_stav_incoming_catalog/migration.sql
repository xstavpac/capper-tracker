-- Lock down stav_incoming_catalog, the raw-text landing table for the retired
-- `ingest-picks` Supabase Edge Function (deleted 2026-11-02). The table is not in
-- schema.prisma. It held 3 TEST rows, archived locally before this migration.
-- Guarded so it is a no-op where the table does not exist (local dev, CI).

DO $$
BEGIN
  IF to_regclass('public.stav_incoming_catalog') IS NOT NULL THEN
    ALTER TABLE public.stav_incoming_catalog ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE public.stav_incoming_catalog FROM anon, authenticated;
  END IF;
END
$$;

-- Later, once the archive is confirmed and nothing references the table, drop it
-- in a SEPARATE migration (do not uncomment here):
-- DROP TABLE IF EXISTS public.stav_incoming_catalog;
