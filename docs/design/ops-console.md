# Ops console (/admin)

The admin-only tabs for watching the app's plumbing while using it. Gate,
DB Monitor and its labels: `docs/design/db-monitor.md`. This doc covers what
the tabs share: red dots, thresholds, the Copy for Claude export, and what
each tab costs.

Tabs (`src/lib/admin-tabs.ts`), built in this order: DB Monitor, Crons,
Odds API, Grading, Imports (with Skipped Lines under it). Every page and
the layout call `requireAdminOpsPage()`.

## Red dots

`src/server/data/admin-status.ts` (`getAdminStatus`), called by the admin
layout after the gate:

- One small read per tab, run together, cached as ONE entry
  (`cacheKeys.adminStatus()`) for `ADMIN_STATUS_CACHE_SECONDS` (180 s). A hit
  costs no query; a miss costs the reads listed below. No user data in it,
  so the admins share it.
- The tab pages read their own data fresh, so a dot can trail its page by up
  to 3 minutes.
- Each tab's rule is a pure function in `src/lib/admin-status.ts` that returns
  a one-line reason or null; the reason shows on hover over the dot (and in
  the screen-reader text).
- A check that throws shows a dot ("Status check failed: ...") instead of
  failing the layout.

Every threshold is in `src/lib/admin-thresholds.ts`.

| Tab | Red when | Read on a cache miss |
|---|---|---|
| DB Monitor | any top-30 statement has a red flag at the default threshold (500 avg rows/call). The three expected-heavy refresh-scores reads only count above 5,000 | the page's own pg_stat_statements statement (30 rows) |
| Crons | a cron's latest run is ERROR (HTTP 5xx, a body with status "error", or a throw), or still RUNNING 60 s past its route's maxDuration (timed out / crashed), or it's overdue: its latest fire time is past its grace (`CRON_GRACE_MINUTES`: 20 min for grade-picks, 30 for backfill-odds, 60 for the daily ones) with no run started at or after it. A WARNING (200 with ok:false) shows on the page but isn't a dot; a cron with no runs logged yet isn't overdue | latest run per cron (`DISTINCT ON (name)` over the `(name, startedAt)` index): 6 rows, inside the combined status statement |
| Odds API | the newest usage row's credits (the Odds API's own x-requests-used / x-requests-remaining) are >= 85% used (`ODDS_CREDITS_ALERT_PCT`, the same number as the `credits ALERT` log line) or under 1,000 left (`ODDS_CREDITS_LOW_REMAINING`, the same env var and default as the `credits LOW` line); or an in-season sport has no snapshot for today's ET date 2h after today's refresh-odds fire (05:05 UTC; nothing is due just after ET midnight, before it fires) | the newest `odds_api_usage_log` row (pollTimestamp index, 1 row) and the newest snapshot per sport (`DISTINCT ON ("sportKey")` over the (sportKey, fetchDate) unique index, ~6 rows, never the `data` blob), inside the combined status statement |
| Grading | at least 1 stuck-pending pick: PENDING, in a sport the grade-picks cron grades (`RESOLVABLE_SPORT_KEYS`), inside the 14-day regrade lookback, and either its matched final was first seen 3+ hours ago (`GRADING_STUCK_AFTER_FINAL_HOURS`) or no final was found 8+ hours after its start (`GRADING_STUCK_NO_RESULT_HOURS`). Sports with no score source, and picks past the lookback, are counted on the page but never turn the dot on | the stuck count plus the oldest stuck pick (1 row), inside the combined status statement |
| Imports | in the last 24h: a GAME_UNMATCHED, PARSE_UNRESOLVED or RECOVERY_UNRESOLVED line, or a pick inserted with no matched game. PARSE_SILENT and PROP_UNSUPPORTED are listed on the page but never turn the dot on | two counts over the window, inside the combined status statement: alerting skipped lines (the (stage, createdAt) index) and the sum of `fallbackUnmatched` over `import_runs` (createdAt index). 1 small json value |

(Each tab's PR fills in its row's exact read and cost.)

## Crons

Every route under `/api/cron` hands its work to `runCronLogged(name, run)`
(`server/data/cron-runs.ts`) right after its CRON_SECRET check, so an
unauthorized hit logs nothing. One insert when the run starts (RUNNING), one
update by id when it ends: status, HTTP status, duration, rows touched and a
small summary read off the route's own JSON response
(`outcomeFromResponse`, `lib/cron-runs.ts` - per route: finals persisted +
picks/legs graded for grade-picks, snapshot rows for refresh-scores, sports
seeded + prop events for refresh-odds, games added for backfill, events
fetched for the NHL pass, roster rows written). Logging is best-effort: a
failed write never fails the cron. About 100 runs a day, ~3k rows a month;
no prune (deletes here are by id only).

## Odds API

`odds_api_usage_log` already had a row per Odds API call with usage headers
(credits used / remaining as of that call, account-wide). Each row now also
records the response's HTTP status and its `caller`: `odds-seed` /
`odds-backfill` (the bulk listing in odds.ts), `nfl-prop-odds` /
`nhl-goal-scorer-odds` (event-level props), `alt-lines`, `fanduel-link`.
Which calls get a row is unchanged (the NFL-prop 95% credit gate reads the
newest row), so a call that throws before any response, or an event-prop call
that fails, still leaves none. Rows from before this change show "not
recorded". Page: latest credits, today's calls by sport x caller x status
(ET day), this month's count, and each sport's newest snapshot - one
statement, a few dozen small rows.

## Grading

`gradePickPool` (the cron's and the page-load fast path's shared pass)
records every pick it can't grade in `pick_grade_failures`, once per pool,
in one upsert (`grading-failures.ts`): no final matched ("no final game
matched (N finals within +-2 days)"), the player-prop grader's own reason
(e.g. the player isn't in the box score - `resolvePlayerProp`), or "matched a
final but couldn't grade this <betType>" for the rest. A matched miss keeps
the GameResult id and its `createdAt` (when the feed first showed it final),
which is what "final 3+ hours ago" measures. Repeat misses bump `attempts` and
`lastSeenAt`. Best-effort: a failed write never stops grading. The candidate
read gained `id` and `createdAt` for this. Parlay legs aren't recorded (picks
only).

Page: one statement - pending by sport (in / past the lookback, stuck), the
stuck total, the 50 oldest stuck picks with their bet text and last reason,
and the fuzzy-graded count over 14 days (the existing
`picks_fuzzy_regrade_idx` partial index covers it). The pending counts scan
PENDING picks across users; only counts and the 50 rows leave the database.

`CRON_JOBS` mirrors `vercel.json` (pinned by `cron-runs-acceptance-test.ts`).
Page: each cron's newest run plus its last 10 in 7 days - two small
statements, read fresh.

## Imports

`bulkImportPicksAction` writes one `import_runs` row per import
(`recordImportRun`, `server/data/import-runs.ts`), after the picks since it
needs their ids: lines submitted, picks inserted, skipped, and the picks
inserted with no matched game - a sport with no score source, so the bet
text became the home team, "-" the opponent and the import time the game
time (pick id, sport, bet text; up to 200). A refused (pick-limit) import
records 0 inserted. The import form also sends how each ambiguous team name
in the paste was settled - the auto-resolution hierarchy's method, or "user"
when it asked - which the server validates (`sanitizeAmbiguityLog`: known
methods only, clipped, at most 100 entries) and stores as auto / asked
counts plus the list. Best-effort: a failed write never fails the import.
The MLP (parlay) import isn't recorded.

Page (`/admin/imports`, last `IMPORT_WINDOW_HOURS` = 24h, all users): one
statement - skipped lines by stage, the newest 30 alerting / listed lines
with their raw text, run totals, the no-matched-game picks, and the
ambiguity decisions aggregated by name, sport and method. The full
date-range report moved to `/admin/imports/skipped-lines` (linked from the
page); `/admin/import-skipped-lines` is gated and redirects there, keeping
`from` / `to`.

## Copy for Claude

Every tab has one, built by `formatAdminReport` (`src/lib/admin-report.ts`):
a title line, header lines, then numbered items with `[FLAG]` lines, the same
shape as the DB Monitor's report. Bet text and raw import lines are included;
user ids and emails never are (callers don't pass them, and `maskIdentifiers`
masks emails, cuids and uuids in anything that slips through). Pick ids
appear shortened to their last 6 characters.

## Later: notify when a dot turns red (not built)

Cheapest route, when wanted:

- one env var holding a webhook URL (ntfy topic, or a Discord / Slack
  incoming webhook - all reach a phone with no new dependency, plain `fetch`);
- piggyback on grade-picks (every 15 min): run `loadAdminStatus()` uncached,
  compare with a tiny `admin_alert_state (tab PK, red, reason, changedAt)`
  table, and post only on a transition to red (and optionally back to clear);
- cost: the same reads as one cache miss, every 15 min.

Email (Resend etc.) needs a new dependency, an API key and DNS records for
bettingview.app; web push needs VAPID keys and a service worker. Both are
heavier than the webhook.
