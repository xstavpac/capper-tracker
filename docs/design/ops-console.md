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
| Odds API | latest credits used >= 85%, or fewer than 1,000 left; or an in-season sport has no snapshot for today's ET date 2h after the refresh-odds run | Odds API PR |
| Grading | at least 1 stuck-pending pick: its game went final 3+ hours ago, or no final was found 8+ hours after start | Grading PR |
| Imports | in the last 24h: a GAME_UNMATCHED, PARSE_UNRESOLVED or RECOVERY_UNRESOLVED line, or a pick inserted with no matched game. PARSE_SILENT and PROP_UNSUPPORTED are listed on the page but never turn the dot on | Imports PR |

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

`CRON_JOBS` mirrors `vercel.json` (pinned by `cron-runs-acceptance-test.ts`).
Page: each cron's newest run plus its last 10 in 7 days - two small
statements, read fresh.

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
