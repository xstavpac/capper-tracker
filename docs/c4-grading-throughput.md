# C4 — grading throughput & queue decision

**Status (2026-08-31):** Instrument first. No cron/runtime/DB tuning and no queue
until the instrumentation produces real numbers. This supersedes the C4 line in
`scale-readiness-followups.md`.

**Epistemic tags used below**
- **Verified** — established directly from this repository or from current
  official Vercel/Supabase/Prisma documentation.
- **[ESTIMATE]** — modeled or calculated from assumptions; **not** measured in
  production.
- **Unknown** — genuinely unavailable from anything inspectable right now.

No [ESTIMATE] number in this document is an observed fact.

---

## 1. Current architecture (Verified)

- `vercel.json`: one cron for grading — `path: /api/cron/grade-picks`, schedule
  `*/15 * * * *` (every 15 minutes). No `functions` block anywhere in
  `vercel.json` (no per-function `maxDuration` / `memory` / `runtime` / region).
- `src/app/api/cron/grade-picks/route.ts`: `export const maxDuration = 60`,
  `export const dynamic = "force-dynamic"`, no `runtime` export (⇒ Node.js), no
  `preferredRegion`.
- Next.js `14.2.35`.
- `prisma/schema.prisma` datasource: `url = env("DATABASE_URL")`,
  `directUrl = env("DIRECT_URL")`. No `connection_limit`, `pgbouncer`, or
  `pool_timeout` in the schema.
- `src/lib/prisma.ts`: `new PrismaClient()` with **no configuration** — no
  `datasources` override, no explicit pool settings. Just the dev hot-reload
  singleton guard. All request paths and all 5 sport callbacks in the cron
  share this one `PrismaClient` instance ⇒ **one connection pool**.

## 2. Actual grading flow (Verified — traced in code)

```
grade-picks GET:
  auth check (CRON_SECRET bearer, if configured)
  await Promise.all( RESOLVABLE_SPORT_KEYS.map( async sportKey => {   // 5 sports CONCURRENT
      await persistFinalScores(sportKey)                              // 5 phases SEQUENTIAL
      await gradeAllPendingPicks(sportKey, sportName)                 //   within a sport
      await regradeAllFuzzyMatchedPicks(sportKey, sportName)
      await gradeAllPendingLegs(sportKey, sportName)
      await regradeAllFuzzyMatchedLegs(sportKey, sportName)
  }))
  for (userId of changedUserIds) revalidateTag(dashboard(userId)), revalidateTag(reports(userId))
  Response.json({ ... })

gradeAllPendingPicks(sportKey, sportName, maxPicks = 500):
  sport.findUnique  →  pick.count  →
  pick.findMany({ where:{ sportId, status:PENDING }, orderBy:{ gameTime:asc }, take: 500 })  →
  gradePickPool(picks, sportKey, sportName)

gradePickPool(picks, sportKey, sportName):
  candidates = ONE gameResult.findMany({ sportKey, gameDate in [min(gameTime)-2d, max(gameTime)+2d] })
  inChunks(picks):  for (i += BULK_GRADE_CONCURRENCY=50)  await Promise.all( chunk.map(perPick) )
    perPick:
      matchGameResult(candidates, pick)          // pure, in-memory
      resolveOutcome(pick, game)                 // pure, in-memory      — OR —
      gradeTouchdownProp(pick, externalId, ...)  // ESPN fetch, next:{revalidate:3600}, NFL PLAYER_PROP only
      await prisma.pick.update({ where:{ id }, data:{ status, gradedAt, gradedViaFuzzyMatch } })  // AUTOCOMMIT
```

- `RESOLVABLE_SPORT_KEYS` = `baseball_mlb`, `basketball_nba`, `basketball_wnba`,
  `americanfootball_nfl`, `americanfootball_ncaaf` (5).
- `BULK_GRADE_CONCURRENCY = 50` (`grading.ts`; duplicated in `parlay-grading.ts`).
- Caps: `maxPicks = 500` per sport, `REGRADE_MAX_ROWS = 2000`, `maxLegs = 500`
  per sport, regrade lookback 14 days.
- **No `$transaction`, `$executeRaw`, or interactive transaction anywhere in
  the grading paths.** Every `pick.update` / `leg.update` is autocommit.
- `recomputeParlayBetStatus` is **already** a compare-and-swap:
  `prisma.parlayBet.updateMany({ where: { id, status: "PENDING" }, data })`.
- The M4a batching (`gradePickPool` / `regradeFuzzyPool` / `fetchCandidatePool`
  / `inChunks`) and the pure `matchGameResult` / `resolveOutcome` / `gradePick`
  functions are the baseline and are unchanged by C4.

## 3. Concurrency characteristics (Verified reasoning)

The cron's `Promise.all` over 5 sports runs the 5 sport callbacks concurrently.
Within a sport, `gradePickPool`'s `inChunks` issues bursts of up to 50
`pick.update` promises.

- **In-flight promise count** peaks at ~`5 sports × 50 = 250` `pick.update`
  promises.
- **Actual concurrent database writes** = `min(250, effective connection_limit)`.
  Everything above `connection_limit` **queues inside the Prisma client**, not
  at Postgres.
- Therefore the sport count multiplies *Prisma-side queue depth*, **not**
  database write throughput. Whole-run grading-write throughput is
  approximately `connection_limit ÷ write_round_trip_latency`.
- **If `connection_limit` is small (e.g. 1–3, the common serverless value),
  `BULK_GRADE_CONCURRENCY = 50` and the 5-way sport parallelism are largely
  cosmetic** — all grading writes for the whole run serialize through 1–3 real
  connections.

## 4. Measured vs estimated throughput

- **Measured production data: none.** There is no run-duration logging or
  metrics today. The cron returns `graded` / `remaining` in its JSON body, but
  nothing captures it. The instrumentation added alongside this document (the
  `grade-picks-run` log line) is the first source of real numbers.
- **Defensible hard number — structural cap only (Verified):**
  `maxPicks 500 × 5 sports = 2,500 pick-grades per run` and
  `maxLegs 500 × 5 = 2,500 leg-grades per run`. At the `*/15` schedule this is
  a ceiling of **[ESTIMATE] ~10,000 pick-grades/hour** — and only *if* every
  run completes within its 15-minute window and every sport has ≥ 500 pending.
  Whether runs complete in time is **Unknown** (unmeasured).
- **Per-run wall-clock: [ESTIMATE] only** — dominated by 2,500–10,000 autocommit
  writes at unknown effective concurrency (see §7 `connection_limit`) and
  unknown Vercel↔Supabase latency. Plausible band **[ESTIMATE] ~10–70 s**,
  which straddles both "comfortably under `maxDuration = 60`" and "exceeds it."
  Cannot be narrowed without the `connection_limit` value **and** one real
  run's logs.
- **50k-user projections: [ESTIMATE]** built on the assumptions in §5. Not
  recorded here as throughput facts; revisit once §4 has measured data.

## 5. Assumptions & confidence

Assume a **realistic mixed user base**, not a bulk-importer-heavy skew.

| # | Assumption | Confidence |
|---|---|---|
| A1 | Pick volume at 50k users follows a power law — weighted **~2–4 picks/day/user**, **~100–200k picks/day** total. | Medium |
| A2 | **40–65%** of a day's gradeable picks resolve inside a **4–6 hour** window; football Saturdays/Sundays are the worst case. | Medium |
| A3 | Steady state: picks created/day ≈ picks gradeable/day. | High |
| A4 | Vercel and Supabase are co-located in `us-east-1`; write round-trip **[ESTIMATE] ~4–8 ms**. | Medium — Vercel region unverified; Supabase region inferred from the pooler host. |
| A5 | Supabase Pro + at least Small compute; Supavisor multiplexes to hundreds of client connections. | Medium |
| A6 | Vercel plan is Pro. | Medium-high — inferred from a `"plan":"pro"` claim in a now-deleted `vercel env pull` artifact, not the dashboard. |

## 6. Concurrency & correctness properties relevant to any future change (Verified)

- **Grading outcomes are deterministic** — `resolveOutcome` / `gradePick` are
  pure functions of `(pick fields, GameResult row)`. Two workers that both read
  a pick as PENDING and match it to the same GameResult compute the **identical**
  status. A "lost" write loses no information (only `gradedAt` differs by ms).
- **Per-pick side effects before the DB write** — `matchGameResult` (pure),
  `resolveOutcome` (pure), `gradeTouchdownProp` → cached ESPN GET (no mutation),
  `changedUserIds.add()` (in-memory). The `pick.update` is the only side effect.
- **`revalidateTag`** runs in the route after the pools return, per changed
  user; calling it twice for the same user is idempotent.
- **Present-day fragility (Verified):** `prisma.pick.update({ where: { id } })`
  throws Prisma `P2025` if the pick was deleted mid-run — now possible via the
  pick-delete feature. That rejection propagates out of `Promise.all` and 500s
  the whole cron run; Vercel does **not** retry it, so that run's grading is
  lost until the next tick. See §9 (deferred `updateMany` hardening).

## 7. Unresolved production facts

| Fact | Status | How to resolve |
|---|---|---|
| **Prisma `connection_limit`** (and whether `DATABASE_URL` is transaction pooler `:6543`, session pooler `:5432`, or direct; whether `pgbouncer=true`; `pool_timeout`) | **Unknown.** Not in the repo. The prod `DATABASE_URL` is Sensitive-type in Vercel (masked on `vercel env pull`) and was set manually. Prisma's default when absent is `num_physical_cpus * 2 + 1`, and the CPU count Prisma detects on a Vercel function is itself uncertain. | Owner pastes the prod `DATABASE_URL` **query string only** (host:port + params, credentials redacted). |
| **Fluid Compute enabled for this project?** | **Unknown.** Project-level dashboard toggle (Settings → Functions), not in any repo file. Default-on only for projects created after the mid-2025 rollout; this project predates that. | Owner reads Vercel → Settings → Functions. Determines whether the max function duration is **300 s** (no Fluid) or **800 s** (Fluid), per current Vercel docs. |
| Vercel deployment region | Unknown | Vercel → Settings → Functions (default region). Affects A4. |

## 8. Overlap protection — why `pg_try_advisory_lock` is not acceptable now

- **Verified:** Vercel does not prevent overlapping cron runs. Its docs: *"If
  your cron job runs longer than the interval between invocations, Vercel can
  trigger a second instance while the first is still running. This can lead to
  race conditions, duplicate processing, or data corruption."* It also does
  **not** retry a failed invocation, and delivery is best-effort (can
  double-invoke or skip a scheduled run).
- **Verified:** session-level `pg_advisory_lock` / `pg_try_advisory_lock` is
  **incompatible with Supavisor transaction mode (`:6543`)** — *"Session-level
  settings cannot be used with Supavisor in Transaction mode."* Transaction
  mode reassigns the backend connection per transaction, so a lock acquired in
  one statement is stranded on a backend the next query won't get.
- `pg_advisory_xact_lock` (transaction-scoped) works with transaction pooling
  but auto-releases at transaction end — it cannot span the multi-statement
  grading run, which is deliberately not wrapped in a transaction.
- We also do not know whether `DATABASE_URL` is transaction mode (§7), so the
  guard's safety cannot even be assessed today.

**Conclusion:** no advisory-lock guard. It is also not *needed* now — the cron
frequency is not being changed, and the grading writes already tolerate a
double invocation (deterministic outcomes), except for the `P2025` fragility in
§6.

**Possible future mechanism if cron frequency is ever increased:** a
**row-based lock table** (`cron_lock(name text pk, locked_at timestamptz,
holder text)`), acquired with
`INSERT … ON CONFLICT (name) DO UPDATE SET locked_at = now(), holder = $run
WHERE cron_lock.locked_at < now() - interval '<TTL>' RETURNING name` — 0 rows
means a fresh holder exists, so the run exits. Pooler-agnostic (plain DML),
stale-lock recovery via the TTL. Costs: one migration and a TTL to tune above
the longest legitimate run. **Not implemented; recorded as the approach.**

## 9. Intermediate tuning options considered (none implemented)

| Option | Gating unknown / prerequisite |
|---|---|
| Enable Fluid Compute + raise `maxDuration` 60 → 300 | §7 Fluid state; one real run's `totalMs` (if runs are well under 40 s this is premature). |
| Cron `*/15` → `*/5` (Pro allows per-minute — Verified) | A real run duration; confirmation runs aren't already overlapping/skipped; the row-lock guard (§8) built first. |
| `maxPicks` 500 → 1500 | Same as above; multiplies with frequency. |
| Verify / adjust `connection_limit` | **Report the discovered value first.** Do not change without explicit approval — if it is `=1` that is a deliberate serverless tradeoff needing Supabase-compute-tier coordination. |
| `BULK_GRADE_CONCURRENCY` 50 → higher | Only helps if `connection_limit` allows it; risks a write storm otherwise. |
| Conditional `updateMany({ where: { id, status: "PENDING" } })` grading writes | Deferred, independently justified as a **delete-race fix** (§6). Safe for every grading path (deterministic outcomes; no pre-write side effects; `recomputeParlayBetStatus` already a CAS). Needs its own idempotency/race tests. Not part of the instrumentation commit. |
| Raw-SQL write batching (`$executeRaw` CASE) | Excluded — real correctness risk for a problem tuning solves. |

## 10. Current decision

**Instrument first.** Add the `grade-picks-run` structured log line (done
alongside this document — measurement only: no query, no write, no locking, no
retry, no branching, HTTP response unchanged). Collect ~1 week including a
football Saturday/Sunday, then use `totalMs`, per-phase timings, and
`remaining` to make the §9 decisions.

**Do NOT, in this pass:** change `maxDuration`, Fluid Compute config,
`DATABASE_URL`, `connection_limit`, Prisma connection settings, cron frequency,
`maxPicks`, `BULK_GRADE_CONCURRENCY`; add advisory locks or a row-lock table;
apply the `updateMany` hardening; build a queue; touch M2 / M7 / M9.

## 11. Deferred: the queue

Not now. Current scale does not need it; the measured tuning path in §9 is
expected to cover the realistic 50k-user range (§5, [ESTIMATE]); Vercel Queues
is in public beta; and the migration, though low-risk, is real work.

## 12. Eventual queue recommendation — FUTURE, not being implemented

This is a **future architectural recommendation**, recorded so the eventual
work starts from a verified position. Nothing here is being built now.

**Choice: Vercel Queues, push mode.** Verified against current docs:
at-least-once delivery; automatic retries until TTL (first 32 attempts honor a
configured delay, then forced exponential backoff); **no built-in DLQ**
(app-level poison policy: acknowledge + log after N attempts); idempotency key
on publish deduplicates for the message's lifetime; **configurable max
concurrency per consumer group** (the global write throttle); visibility
timeout default 60 s, extendable; retention 60 s–7 days; push consumer is a
`queue/v2beta`-triggered Route Handler declared in `vercel.json`
`functions.<route>.experimentalTriggers`, air-gapped (no public URL, no auth),
runs on Fluid Compute; ordering is approximate, **not FIFO**. Pricing: 1M
operations/month included on all plans, then $0.60 per 1M.

**Shape:**
- The cron becomes a **producer** — for each sport, `persistFinalScores`
  inline, then `pick.findMany({ select: { id }, where: { sportId, status:
  PENDING }, orderBy: { gameTime: asc }, take })`, chunk the IDs into
  `(sportKey, [~300 pick IDs])` messages with idempotency key =
  hash(sportKey + sorted IDs). Same for regrade-picks / grade-legs /
  regrade-legs. Returns in seconds regardless of backlog.
- The **consumer** (push-mode Route Handler) re-queries the batch's IDs with
  `status: PENDING`, calls the **unchanged** `gradePickPool` (or
  `regradeFuzzyPool`), then `revalidateTag` per changed user.
- `gradeAllPendingPicks` shrinks to the producer's select-and-enqueue; its
  current body already *is* the `gradePickPool` call.
- **No grading logic is duplicated.** The queue changes only *who calls
  `gradePickPool` and with which pick set*.
- Global write concurrency is bounded by the consumer group's max-concurrency
  setting × per-handler `BULK_GRADE_CONCURRENCY`, independent of backlog size.
- Correctness rests on: the consumer's `status: PENDING` re-query (idempotency
  guard for at-least-once / duplicate delivery / retry-after-DB-success), the
  `updateMany` PENDING-gate from §9, deterministic outcomes (§6), and
  `recomputeParlayBetStatus` already being a CAS. No transaction wraps a batch
  — per-pick independence means partial failure + retry is safe.
- New queue-specific tests would be needed (pure, mocking `prisma.pick.*`):
  idempotency (double-invoke → 0 writes), PENDING-gate, partial failure +
  retry, batch coverage (disjoint + complete), duplicate regrade delivery.
  `grading-correctness-acceptance-test.ts` and
  `grading-pool-match-acceptance-test.ts` remain valid unchanged.

**Documented alternatives** (pricing verified 2026-08):
- **QStash** — portable HTTP queue; Free 1k msg/day; PAYG $1 / 100k messages;
  ~$0–5/month at our [ESTIMATE] volume. Viable, fewer ergonomics.
- **Inngest** — Hobby 50k executions/month; **Pro $99/month** (1M executions
  incl., ~$50 per additional 1M). Jumps to $99/month once past ~25k grading
  runs/month. More capable (durable multi-step) than this workload needs.
- **BullMQ** — **ruled out.** MIT-free library, but requires a persistent
  worker process polling Redis; this stack has no such host, and adding one
  (Railway/Fly/Render) plus managed Redis is cost + operational burden to
  avoid a problem the platform now solves natively.

## 13. Triggers to revisit (queue and/or tuning)

Act when **any** of these is true, using the new instrumentation:

1. **`remaining > 0` for 3+ consecutive runs** during a peak window (backlog
   is actually accumulating, not just a one-off).
2. **`totalMs` consistently exceeds ~50% of the configured `maxDuration`**
   (headroom gone).
3. **Active users (30-day) cross ~10,000** — the conservative low end of the
   §5 estimate band; a leading indicator so a queue lands *before* the first
   bad football Sunday, not during one.
4. **[recommended] p95 grading latency** — time from `GameResult` persistence
   (final score recorded) to the pick's `gradedAt` — **exceeds ~20 minutes
   sustained** across a peak window. This is the actual user-facing SLO and
   captures the page-load fast path too; more defensible than raw backlog
   count. Requires adding `gradedAt − GameResult.createdAt` to the
   instrumentation.

Triggers 1–2 are measurable from the `grade-picks-run` log line today.
Trigger 4 needs a small follow-up to the instrumentation.
