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
| Crons | a cron's latest run failed (ERROR, or still RUNNING past its maxDuration), or it's overdue: no run started within its interval plus grace | Crons PR |
| Odds API | latest credits used >= 85%, or fewer than 1,000 left; or an in-season sport has no snapshot for today's ET date 2h after the refresh-odds run | Odds API PR |
| Grading | at least 1 stuck-pending pick: its game went final 3+ hours ago, or no final was found 8+ hours after start | Grading PR |
| Imports | in the last 24h: a GAME_UNMATCHED, PARSE_UNRESOLVED or RECOVERY_UNRESOLVED line, or a pick inserted with no matched game. PARSE_SILENT and PROP_UNSUPPORTED are listed on the page but never turn the dot on | Imports PR |

(Each tab's PR fills in its row's exact read and cost.)

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
