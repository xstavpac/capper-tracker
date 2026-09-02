# Scale-readiness follow-ups

Tracked items from the scale-readiness work (audit target: 50,000 users).

## Shipped

- **Units chart downsampling (dashboard)** - 2026-09, `fd36a99`.
  `computeUnitsChartData` returned one point per settled pick.
  `src/server/data/units-chart-downsample.ts` (`downsampleUnitsChart`) applies
  extrema-preserving **index** bucketing (the chart x-axis is a categorical
  `dataKey="date"`, i.e. pick-sequence, not a time scale) when a series exceeds
  `UNITS_CHART_MAX_POINTS` (2000): first/last kept exactly, each of ~999
  interior buckets keeps its cumulative-value min AND max, every returned point
  is an exact original in order, `downsampled[last].cumulative ===
  full[last].cumulative` exactly. Applied **only inside
  `computeDashboardSummary`**; `computeUnitsChartData` /
  `computeCumulativeUnitsSeries` / `computeMaxDrawdown` stay full-fidelity.
  Deterministic, caches under the existing `dashboard:${userId}` key.

- **M2 - auth double round-trip** - 2026-09, `bc3be6e`. `supabase.auth.getUser()`
  ran in middleware **and** `getCurrentUser()` (two Supabase Auth network calls
  per request). Both now call `supabase.auth.getClaims()` - this project signs
  JWTs with an asymmetric ES256 key, so it verifies the signature locally via
  WebCrypto against a cached JWKS, no Auth-server round-trip on the hot path.
  Token refresh unchanged. Security tradeoff + deferred JWT-expiry decision in
  `docs/m2-auth-round-trips.md`.

- **M7 - Stripe webhook transient-failure loss** - 2026-08, `adc0bc1`. The
  webhook recorded the event id as processed before running the handler, so a
  transient mid-handler failure stranded the subscription mutation and Stripe's
  retry hit the dedupe skip. `applyStripeWebhookEvent`
  (`src/server/data/stripe-webhook.ts`) now claims the event id and applies
  every subscription write in one transaction - a handler throw rolls back the
  claim too, so the retry reprocesses cleanly; exactly-once preserved. Design C
  (status column + replay cron) recorded as the future async step in
  `docs/m7-stripe-webhook-idempotency.md`.

- **M9 - `recomputeTeamTendencies` unbounded scan** (instrumented; bounded fix
  deferred) - 2026-08, `6f5bf8f`. The tendencies are all-captured-history
  (career) metrics by design, so there is no date bound to add.
  `select`-narrowed both queries; the `refresh-scores` cron now logs per-sport
  scan sizes + timings (`refresh-scores-run`). The larger fix (Option A - drop
  the `OddsSnapshot` scan, read `GameResult.favTeam`/`totalLine`) is documented
  in `docs/m9-team-tendencies.md` with triggers to act on; it touches the
  grading path, so it needs its own scoped approval.

- **C4 - grading throughput instrumentation** - 2026-08, `026945e` / `bad21d0`.
  The `grade-picks` cron emits a `grade-picks-run` structured log line
  (per-phase timings, backlog counts), and the grading writes are hardened
  against the delete-mid-run race (conditional `updateMany`). The queue /
  worker architecture itself remains deferred - see below.

## Not yet started

### Units chart on the per-capper page (client-side cost)

`cappers/[capperId]/page.tsx` calls `computeUnitsChartData` directly, uncached,
and is not downsampled. Series there are per-single-capper and windowed, so
much smaller than the dashboard's cross-capper total - apply
`downsampleUnitsChart` here if a whale capper's all-time view ever proves
heavy. The capper-comparison overlay (`computeUnitsChartByPickNumber`) is
untouched too; it is per-single-capper and index-based already, so the same
helper would drop in. Purely a rendering/payload concern.

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
(~240k grades/day capacity). Instrumentation shipped (see "Shipped" above);
revisit a queued/batched background job only once the `grade-picks-run` metrics
show the pending backlog actually approaching that ceiling - not before.
Eventual queue recommendation (Vercel Queues, push mode) is written up in
`docs/c4-grading-throughput.md`.
