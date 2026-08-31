# Scale-readiness follow-ups

Tracked items deferred out of the scale-readiness work (audit target: 50,000
users). Each was deliberately left for later, not forgotten.

## Not yet started

### Units chart emits one point per pick (client-side cost)

`computeUnitsChartData` / `computeUnitsChartByPickNumber` return one data
point per settled pick. A power user with 10k-30k picks makes the dashboard
(and the per-capper page, and the capper-comparison overlay) render an SVG
with that many points - a real client-side cost even though the server-side
query is now lean and cached.

**Fix when it matters:** downsample the series server-side to ~500 points
(e.g. largest-triangle-three-buckets, or simple every-Nth with the last
point always kept) before returning it from `computeDashboardSummary` and the
capper pages. Keep the full-resolution series only where the exact shape is
load-bearing (it currently isn't - the chart is decorative trend context).

Scope note: purely a rendering concern. The M3 work (2026-08) made the
underlying query lean + cached; this is the remaining piece and is safe to
do independently.

### M2 - Auth double round-trip

`supabase.auth.getUser()` runs in middleware **and** again in
`getCurrentUser()`, both network calls to Supabase Auth, on every request
including every 25s `/api/live/scores` poll. Fix: verify the JWT locally
(`jose` / project JWT secret) in the fast path, reserve `getUser()` for where
freshness matters.

### M7 - Stripe webhook: transient failure loses the update

On a handler exception the event is already marked processed, so Stripe's
retry hits the idempotency skip and 200s without applying. Under DB
contention at scale this silently strands a few users on the wrong plan.
Fix: only mark processed after the handler succeeds, or record a
failed-events table for replay.

### M9 - `recomputeTeamTendencies` unbounded scan

Loads every `GameResult` + every `OddsSnapshot` for a sport on each daily
`refresh-scores` run. Grows with years of history (not users). Window it to
the last N days once the row counts justify it.

## CI / tooling

### Bump CI `node-version` from 20 to 22

`.github/workflows/ci.yml` pins `actions/setup-node` to `node-version: 20`.
GitHub is deprecating the Node 20 runtime and already forces `checkout` /
`setup-node`'s own action code onto Node 24 (a `##[warning]` in every run,
linking https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/).
That deprecation currently only affects the actions themselves, not the
`node-version` we install for our own steps - so nothing is broken. Bump to
`node-version: 22` (current LTS) once GitHub extends the deprecation to
user-workflow versions, or opportunistically. Local dev is on Node 24
already; the runner script uses `node --import tsx`, which needs Node >= 20.6,
so 22 is fine.

### Give CI a seeded Postgres so the model-engine suites run there

Six suites need a database with production-like historical rows (specific
hardcoded cuids like the "real Rangers/Braves GameResult"): the five under
`src/server/data/model-engine/` plus `weighted-accumulation` (which reaches
the DB transitively via `resolveGameObservations`). `scripts/run-tests.mjs`
skips any suite that needs a DB when `DATABASE_URL` is unset, so CI currently
reports them as SKIP rather than running them.

To run them in CI: add a `postgres:16` service container to the `verify`
job, run `prisma migrate deploy` against it, and add a CI-specific seed that
creates the exact fixture rows those suites assert on (the regular
`prisma/seed-dev.ts` is synthetic and does not reproduce them). Then set
`DATABASE_URL` for the `npm test` step so the skip logic lets them run.
`prisma/seed-dev.ts` is the starting point for the seed; the fixture ids the
suites expect can be pulled from the assertions in each file.

## Deferred by explicit decision

### C4 - Grading queue / worker architecture

`gradeAllPendingPicks` is capped at 500 picks/sport/run every 15 min
(~240k grades/day capacity). Revisit a queued/batched background job only
once production metrics show the pending backlog actually approaching that
ceiling - not before. Building it now would be premature.
