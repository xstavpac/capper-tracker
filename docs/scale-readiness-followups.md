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

## Deferred by explicit decision

### C4 - Grading queue / worker architecture

`gradeAllPendingPicks` is capped at 500 picks/sport/run every 15 min
(~240k grades/day capacity). Revisit a queued/batched background job only
once production metrics show the pending backlog actually approaching that
ceiling - not before. Building it now would be premature.
