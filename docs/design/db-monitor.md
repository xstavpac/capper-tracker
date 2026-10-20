# DB Monitor (admin ops console)

`/admin/db-monitor`: pg_stat_statements on the admin page, to spot runaway
queries while using the site. First tab of the `/admin` ops console.

## Gate

`admin_ops_console` feature flag (migration
`20261019120000_add_admin_ops_console_flag`: OFF globally, overrides for the two
admin accounts). `src/server/admin-gate.ts` is the only place that checks it:

- `requireAdminOpsPage()` in `admin/layout.tsx` **and** every page under it (a
  layout isn't re-rendered on every child navigation, so it can't be the only
  guard). Non-admins get a 404.
- `requireAdminOpsAction()` as the first statement of every admin server action.

`db-monitor-acceptance-test.ts` pins both by reading the source.

## Cost

One monitor statement per page load (`loadDbMonitorSnapshot`), plus the gate's
flag read. No cache (a cached copy is someone else's minute), no polling. It
returns at most 30 statement texts, a few KB each.

## What it shows

- Statements in this database whose text names a public table (bare or
  `public.`-qualified, not `auth.users`), top 30 by `rows`.
- Text from the outermost FROM onward; a `WITH` / DML statement whole. Comments
  and the `"public".` prefix dropped.
- Header: time since `stats_reset`, total rows over every statement in the
  database, `dealloc` (evictions, which make totals undercount), and
  rows x approx row width (`APPROX_ROW_BYTES`, measured on the 2026-09-15 prod
  dump), labelled an estimate.
- **Reset stats**: `pg_stat_statements_reset()` with its defaults, so the whole
  server, every role. It also clears Supabase's Query Performance view.
- **Copy for Claude**: the same data as plain text. pg_stat_statements has no
  app user ids or parameter values, and `redactLiterals` masks anything that
  looks like one.

## Labels and red flags

Fingerprints in `src/lib/db-monitor.ts` (`STATEMENT_LABELS`), each taken from the
statement its code path really sends: query-log captures against the local DB,
stored in `src/lib/db-monitor-fixtures.ts`. Re-capture rather than hand-edit.

Every statement in the 2026-10-19 prod top 30 has a label, named for the code
path that sends it (each label's `source` says which). Three of them -
grade-picks' and refresh-scores' upserts into `game_results`,
`nfl_team_stat_snapshots` and `team_tendency_snapshots` - need live feeds to
run, so their fixture text is production's own pg_stat_statements entry; the
rest were captured locally with writes rolled back. The egress-plan reads
(2026-10-20, `scripts/db-monitor-capture/capture-ops.mts`) added labels for the
roster tables (`Roster cache`, `Roster refresh diff`, `NFL roster names`), the
capper name scan, and the batched `Tendency history (batch)` read; `Capper
roster` dropped "(full row)" since #297 narrowed it. The two whole-table roster
reads both select the row id; they are told apart by column order (the refresh's
diff read names the player id second).

Expected-heavy reads: refresh-scores reads three things in full once a day on
purpose - `Odds for tendencies`, `Game observations (model)` and
`Decay-delta persisted ids` - and the refresh-rosters cron reads each roster
table in full (`Roster refresh diff`). Up to `EXPECTED_HEAVY_MAX_AVG_ROWS` (5,000) avg
rows/call they show "expected (daily cron, full history)" instead of a row
threshold flag; above it they flag. Drop the allowance if those reads get
bounded. Both numbers live in `src/lib/admin-thresholds.ts`, with every other
ops-console threshold.

Red flags:

| Code | Rule |
|---|---|
| RETIRED_A | full-row picks, `userId =` + `capperId IN (`, no gameTime bound (fetchPicksByCapper, #130) |
| RETIRED_B | `picks LEFT JOIN sports` filtered on the joined sport's `name`, no gameTime bound (raw panel, #128) |
| RETIRED_C | picks whose WHERE is `userId =` **alone**, ORDER BY gameTime, no bound, no LIMIT (getPickRowsForStats, #142) |
| UNLABELED_FULL_ROW | no label, and the SELECT list names at least `PICK_COLUMN_COUNT - 3` picks columns |
| ROW_THRESHOLD | avg rows/call above `?threshold=` (default 500); an expected-heavy label instead above its 5,000 ceiling |

C is narrower than "userId + ORDER BY gameTime, no bound or LIMIT" on purpose:
capper comparison also fits that, but it is scoped to one capper by design. Its
size shows up through the row threshold instead.

## Proposed, not built: hourly snapshot cron

For per-hour trends. Goes in with the rest of the ops console work.

- `/api/cron/db-stats-snapshot`, hourly, `CRON_SECRET` like the other crons
  (grade-picks already runs every 15 minutes, so the plan allows hourly).
- Tables (one migration, its own prod-migration approval):
  - `db_stat_snapshots(capturedAt, queryid, calls, rows, totalExecMs)`: the
    top 30 per run;
  - `db_stat_statements(queryid PK, label, tailText, firstSeenAt)`: written
    only when a queryid is new.
- Per-hour figures are the differences between consecutive snapshots of a
  queryid; a negative difference means a reset in between and is dropped.
- Keep 14 days (about 30 x 24 x 14 = 10k rows); prune in the same cron.

Egress estimate:

- Each run reads 30 rows of counters, about 3 KB (no text after a queryid's
  first sighting), so 24 runs/day x 30 days x 3 KB = about 2-3 MB a month.
- Writes are ingress, not egress.
- Viewing 14 days of trends reads up to about 10k small rows, roughly 0.8 MB per
  view, or a few KB if the page groups by day in SQL.
