# Scale-readiness follow-ups

Tracked items deferred out of the scale-readiness work (audit target: 50,000
users). Each was deliberately left for later, not forgotten.

## Not yet started

### Units chart downsampling - DONE for the dashboard (2026-09)

`computeUnitsChartData` returned one point per settled pick; a 20k+ settled
history is more points than the ~900px chart renders distinctly and bloated
the M3 dashboard cache payload.

**Done:** `src/server/data/units-chart-downsample.ts` - `downsampleUnitsChart`
applies extrema-preserving **index** bucketing (the chart's x-axis is a
categorical `dataKey="date"`, i.e. pick-sequence, not a time scale) when a
series exceeds `UNITS_CHART_MAX_POINTS` (2000). First and last points kept
exactly; each of ~999 interior buckets keeps its cumulative-value min AND max;
every returned point is an exact original in order;
`downsampled[last].cumulative === full[last].cumulative` exactly. Applied
**only inside `computeDashboardSummary`** - `computeUnitsChartData`,
`computeCumulativeUnitsSeries`, and `computeMaxDrawdown` stay full-fidelity.
Deterministic, so it caches under the existing `dashboard:${userId}` key with
no new dimension. Tested in `units-chart-downsample-acceptance-test.ts`
(reconstruction error, cross-bucket extrema survival, exact endpoints,
threshold pass-through).

**Still open (lower priority):** the per-capper page
(`cappers/[capperId]/page.tsx`) calls `computeUnitsChartData` directly,
uncached, and is not downsampled. Series there are per-single-capper and
windowed, so much smaller - apply the same helper if a whale capper's
all-time view ever proves heavy. The capper-comparison overlay
(`computeUnitsChartByPickNumber`) is also untouched; it is per-single-capper
and index-based already, so the same helper would drop in.

### Units chart emits one point per pick on the per-capper page (client-side cost)

See the "Still open" note directly above - the dashboard is handled; the
per-capper page and comparison overlay are the remaining, lower-priority
surfaces. Purely a rendering/payload concern; the M3 work made the underlying
query lean + cached.

### M2 - Auth double round-trip - DONE (2026-09, bc3be6e)

`supabase.auth.getUser()` ran in middleware **and** again in `getCurrentUser()`,
two network calls to Supabase Auth on every request (incl. every 25s
`/api/live/scores` poll). Both now call `supabase.auth.getClaims()`, which -
this project signs JWTs with an asymmetric ES256 key - verifies the token
signature locally via WebCrypto against a cached JWKS, no Auth-server
round-trip on the hot path. Token refresh (via `getSession()` internally) is
unchanged. Full writeup, security tradeoff, and the deferred JWT-expiry
decision in `docs/m2-auth-round-trips.md`.

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
