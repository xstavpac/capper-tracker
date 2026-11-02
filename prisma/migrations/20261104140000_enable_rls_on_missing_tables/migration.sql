-- These five tables were created without ENABLE ROW LEVEL SECURITY (see the
-- project convention in 20260915120000_enable_rls_on_all_tables: RLS on, no
-- policies). Prod was fixed by hand in the SQL editor on 2026-11-04; this
-- migration makes every environment match. ENABLE is idempotent.
ALTER TABLE "nhl_roster_players" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mlb_roster_players" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cron_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pick_grade_failures" ENABLE ROW LEVEL SECURITY;
