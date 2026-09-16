-- Enable Row Level Security on every application table, with zero policies
-- (deny-all for the PostgREST anon/authenticated roles, which Supabase's
-- auto-generated REST API uses by default when a table has RLS off).
--
-- This app never queries these tables through the Supabase JS client /
-- PostgREST (confirmed by repo-wide search: zero uses of supabase.from(),
-- rest/v1, apikey, or SUPABASE_SERVICE_ROLE - Supabase JS usage here is
-- Auth-only). All application data access goes through Prisma via
-- DATABASE_URL/DIRECT_URL, connecting as the `postgres` role, which has
-- rolbypassrls = true (verified against the DB). RLS therefore has no
-- effect on Prisma/the app regardless of policy state - this migration
-- only closes the anon-key PostgREST exposure that Supabase's security
-- advisor flagged.
--
-- Deliberately no CREATE POLICY statements: deny-all is the intended end
-- state for every one of these tables today.

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stripe_webhook_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leagues" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cappers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dismissed_duplicate_pairs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "picks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "parlay_bets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "odds_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "odds_api_usage_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_tendencies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_tendency_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_stat_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_record_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "situational_rate_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pitcher_stat_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "game_starters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "nfl_team_stat_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "nfl_passer_rows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "nfl_rushing_rows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "nfl_receiving_rows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "custom_metrics" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "custom_metric_points" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "game_results" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decay_delta_predictions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "feature_flags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "feature_flag_user_overrides" ENABLE ROW LEVEL SECURITY;
