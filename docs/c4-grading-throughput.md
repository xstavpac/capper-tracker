# C4 — grading throughput & queue decision

**Status (2026-08-31):** Instrument first. No cron/runtime/DB tuning and no queue
until the instrumentation produces real numbers. This supersedes the C4 line in
`scale-readiness-followups.md`.

**Update (2026-08-31, later):** two previously-Unknown production facts are now
confirmed by the project owner from the Vercel dashboard / env config:

- **Fluid Compute is ENABLED** for this project (Vercel → Settings → Functions).
  The applicable Vercel Pro Fluid Compute maximum function duration is
  **800 s** — **Verified**.
- The current `grade-picks` route still declares **`maxDuration = 60`** —
  **Verified** (repo). So the *platform* ceiling is 800 s while the
  *application* ceiling is 60 s.
- Production `DATABASE_URL` query parameters are **`pgbouncer=true&connection_limit=1`**
  — both **Verified** (owner-confirmed; credentials never requested or exposed).

Throughput numbers that depend on write round-trip latency or on real function
execution time remain **[ESTIMATE]** — knowing `connection_limit=1` does not
convert any modeled number into a measured one.

**Epistemic tags used below**
- **Verified** — established directly from this repository, from current
  official Vercel/Supabase/Prisma documentation, or owner-confirmed from the
  Vercel dashboard/config.
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
- **Fluid Compute is ENABLED** (owner-confirmed). Platform max function
  duration on Vercel Pro + Fluid = **800 s**; the route caps itself at 60 s.
- Next.js `14.2.35`.
- `prisma/schema.prisma` datasource: `url = env("DATABASE_URL")`,
  `directUrl = env("DIRECT_URL")`. No `connection_limit`, `pgbouncer`, or
  `pool_timeout` in the schema — they are set as query parameters on the
  production `DATABASE_URL` env var instead.
- **Production `DATABASE_URL` query parameters: `pgbouncer=true&connection_limit=1`**
  (owner-confirmed). `pgbouncer=true` ⇒ Prisma disables prepared statements and
  treats the connection as transaction-pooled (Supavisor). `connection_limit=1`
  ⇒ Prisma's client-side pool holds **exactly one** connection per running
  function instance.
- `src/lib/prisma.ts`: `new PrismaClient()` with **no configuration** — no
  `datasources` override, no explicit pool settings. Just the dev hot-reload
  singleton guard. All request paths and all 5 sport callbacks in the cron
  share this one `PrismaClient` instance ⇒ **one client-side pool of size 1**.

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

## 3. Concurrency characteristics (Verified)

The cron's `Promise.all` over 5 sports runs the 5 sport callbacks concurrently.
Within a sport, `gradePickPool`'s `inChunks` issues bursts of up to 50
`pick.update` promises.

- **In-flight promise count** peaks at ~`5 sports × 50 = 250` `pick.update`
  promises.
- **`connection_limit = 1` (Verified) ⇒ actual concurrent database writes for
  the entire cron run = 1.** All ~250 in-flight `pick.update` / `leg.update`
  promises — across all 5 sports and all chunks — queue inside the single
  Prisma client and execute **strictly one at a time**. `BULK_GRADE_CONCURRENCY
  = 50` and the 5-way sport `Promise.all` do **not** produce concurrent writes;
  they only change how deep the Prisma-side queue gets. (`pgbouncer=true` means
  each of those serial statements is its own pooled transaction on Supavisor.)
- **Whole-run grading-write throughput ≈ `1 ÷ write_round_trip_latency`.** The
  round-trip latency is **[ESTIMATE]** (see A4) until the instrumentation
  measures it, so the resulting writes-per-second figure is **[ESTIMATE]**.
- Reads in the grading path (`sport.findUnique`, `pick.count`, `pick.findMany`,
  the single `gameResult.findMany` candidate pool) also serialize through the
  same one connection, but there are only a handful per sport.
- The pure work (`matchGameResult`, `resolveOutcome`) is in-memory and does not
  touch the connection.

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
- **Per-run wall-clock: [ESTIMATE] only.** With `connection_limit = 1`
  (Verified), a fully-loaded run performs its writes **serially**: up to
  `2,500 pick.update + 2,500 leg.update = 5,000` serial round-trips, plus
  regrades, plus ~4 serial reads per sport, plus the 5 `persistFinalScores`
  phases (each doing its own external score/odds fetches + per-final-game
  upserts). At an **[ESTIMATE]** write round-trip of ~4–8 ms (A4), 5,000 serial
  writes alone are **[ESTIMATE] ~20–40 s**; a run where several sports are at
  their caps could plausibly **approach or exceed the current 60 s
  application-level `maxDuration`**, well under the 800 s platform ceiling. This
  is a modeled range, not an observation — the instrumentation's `totalMs` will
  replace it.
- **50k-user projections: [ESTIMATE]** built on the assumptions in §5. Not
  recorded here as throughput facts; revisit once measured data exists.

## 5. Assumptions & confidence

Assume a **realistic mixed user base**, not a bulk-importer-heavy skew.

| # | Assumption | Confidence |
|---|---|---|
| A1 | Pick volume at 50k users follows a power law — weighted **~2–4 picks/day/user**, **~100–200k picks/day** total. | Medium |
| A2 | **40–65%** of a day's gradeable picks resolve inside a **4–6 hour** window; football Saturdays/Sundays are the worst case. | Medium |
| A3 | Steady state: picks created/day ≈ picks gradeable/day. | High |
| A4 | Vercel and Supabase are co-located in `us-east-1`; write round-trip **[ESTIMATE] ~4–8 ms**. | Medium — Vercel region unverified; Supabase region inferred from the pooler host. The instrumentation will measure this indirectly (per-phase `gradeMs` ÷ writes performed). |
| A5 | Supabase compute tier and Supavisor pool size are sufficient for the workload. | **Unknown** — the specific compute add-on / pool settings have not been read from the Supabase dashboard. |
| A6 | Vercel plan is Pro. | **Verified** — Fluid Compute (Pro/Enterprise feature) is confirmed enabled. |

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

## 7. Production facts — resolved and still-unresolved

### Resolved (Verified — owner-confirmed 2026-08-31)

| Fact | Value | Implication |
|---|---|---|
| Prisma `connection_limit` | **`1`** (query param on prod `DATABASE_URL`) | The whole cron run's DB writes are serial (§3). |
| `pgbouncer` | **`true`** | Transaction-pooled (Supavisor); prepared statements disabled; session-level advisory locks confirmed unavailable (§8). |
| Fluid Compute | **ENABLED** | Platform max function duration = **800 s** on Pro. The route's `maxDuration = 60` is a self-imposed cap with ~13× headroom to raise. |
| Vercel plan | **Pro** (Fluid is a Pro feature) | Per-minute cron allowed; 800 s duration available. |

### Still Unknown

| Fact | Status | How to resolve |
|---|---|---|
| Write round-trip latency Vercel↔Supabase | **Unknown / [ESTIMATE] ~4–8 ms** | The `grade-picks-run` instrumentation will let us back it out (`gradeMs` ÷ writes performed). |
| Supabase compute add-on / Supavisor pool size / `default_pool_size` | **Unknown** | Supabase dashboard → Database → Connection pooling settings and compute tier. Needed before *raising* `connection_limit` (§ item 2). |
| Vercel deployment region | **Unknown** | Vercel → Settings → Functions (default region). Affects the latency estimate. |
| Real per-run duration / whether `remaining > 0` ever occurs | **Unknown — pending the new instrumentation** (~1 week, incl. a football weekend). | Read the `grade-picks-run` log lines. |

## 8. Overlap protection — why `pg_try_advisory_lock` is not acceptable now

- **Verified:** Vercel does not prevent overlapping cron runs. Its docs: *"If
  your cron job runs longer than the interval between invocations, Vercel can
  trigger a second instance while the first is still running. This can lead to
  race conditions, duplicate processing, or data corruption."* It also does
  **not** retry a failed invocation, and delivery is best-effort (can
  double-invoke or skip a scheduled run).
- **Verified:** `pgbouncer=true` is set on the production `DATABASE_URL` (§7),
  so Prisma is running against a transaction-pooled Supavisor connection.
  Session-level `pg_advisory_lock` / `pg_try_advisory_lock` is
  **incompatible with Supavisor transaction mode** — *"Session-level settings
  cannot be used with Supavisor in Transaction mode."* Transaction mode
  reassigns the backend connection per transaction, so a lock acquired in one
  statement is stranded on a backend the next query won't get. This is now a
  confirmed constraint, not a hypothetical.
- `pg_advisory_xact_lock` (transaction-scoped) works with transaction pooling
  but auto-releases at transaction end — it cannot span the multi-statement
  grading run, which is deliberately not wrapped in a transaction.

**Conclusion:** no advisory-lock guard of any kind. It is also not *needed* now
— the cron frequency is not being changed, and the grading writes already
tolerate a double invocation (deterministic outcomes), except for the `P2025`
fragility in §6.

**Possible future mechanism if cron frequency is ever increased:** a
**row-based lock table** (`cron_lock(name text pk, locked_at timestamptz,
holder text)`), acquired with
`INSERT … ON CONFLICT (name) DO UPDATE SET locked_at = now(), holder = $run
WHERE cron_lock.locked_at < now() - interval '<TTL>' RETURNING name` — 0 rows
means a fresh holder exists, so the run exits. Pooler-agnostic (plain DML),
stale-lock recovery via the TTL. Costs: one migration and a TTL to tune above
the longest legitimate run. **Not implemented; recorded as the approach.**

## 9. Intermediate tuning options considered (none implemented)

| Option | Status now that §7 is resolved |
|---|---|
| Raise `maxDuration` 60 → (up to 800; Fluid is on) | Gives **timeout headroom only** — it does not raise DB throughput (writes stay serial at `connection_limit=1`). Sensible to raise once we know a real `totalMs`, so a long run finishes instead of being killed at 60 s. **Measure first** — pick the value from the measured distribution. |
| Cron `*/15` → `*/5` | Multiplies the *ceiling* by 3, but only helps if a single run actually clears a sport's backlog in time — undetermined until measured. Also **requires an overlap guard** (§8 row-lock table) because a run that already runs long would now overlap the next. **Measure + build guard first.** |
| `maxPicks` 500 → 1500 | With `connection_limit=1` this makes each run **3× longer in serial write time** — a run that is [ESTIMATE] ~30 s at 500/sport becomes [ESTIMATE] ~90 s at 1500/sport, which exceeds the current `maxDuration` and needs it raised. Trades "smaller batches, more runs" for "bigger batches, longer runs" without adding write concurrency. **Measure first; likely prefer frequency over batch size.** |
| Raise `connection_limit` above 1 | The single lever that would actually add write concurrency. **Blocked on Unknown Supabase pool/compute config** (§7). Must not change `DATABASE_URL` without reading the Supabase Connection-pooling settings first. See § item 2. |
| `BULK_GRADE_CONCURRENCY` 50 → higher | **No effect while `connection_limit=1`** — the writes serialize regardless. Only meaningful *after* `connection_limit` is raised. |
| Conditional `updateMany({ where: { id, status: "PENDING" } })` grading writes | Deferred, independently justified as a **delete-race fix** (§6). Safe for every grading path (deterministic outcomes; no pre-write side effects; `recomputeParlayBetStatus` already a CAS). Needs its own idempotency/race tests. Independent of the queue decision. |
| Raw-SQL write batching (`$executeRaw` CASE) | Excluded — real correctness risk. *(Note: at `connection_limit=1` this is the one thing that would meaningfully cut per-run time — collapsing 50 serial round-trips into 1 — but it is out of scope per the owner's constraints.)* |

## 10. Current decision

**Instrument first.** Add the `grade-picks-run` structured log line (done
alongside this document — measurement only: no query, no write, no locking, no
retry, no branching, HTTP response unchanged). Collect ~1 week including a
football Saturday/Sunday, then use `totalMs`, per-phase timings, and
`remaining` to make the §9 decisions.

The two variables that were Unknown at first write are now resolved
(`connection_limit = 1`, Fluid enabled / 800 s ceiling). That sharpens the
picture but does **not** change the decision:

- The write path is now **known** to be single-connection-serial. The only
  in-scope tuning levers (`maxDuration`, cron frequency, `maxPicks`) add
  *timeout headroom* or *more runs*, not *write concurrency* — so they buy
  runway, not a fundamentally different ceiling.
- Raising `connection_limit` — the one lever that adds concurrency — is
  blocked on the still-Unknown Supabase pool/compute config and must not be
  done by editing `DATABASE_URL` blind.
- Therefore the measured `totalMs` / `remaining` still gate every next step,
  and the queue remains the eventual answer for genuine concurrency control.

**Do NOT, in this pass:** change `maxDuration`, Fluid Compute config,
`DATABASE_URL`, `connection_limit`, Prisma connection settings, cron frequency,
`maxPicks`, `BULK_GRADE_CONCURRENCY`; add advisory locks or a row-lock table;
apply the `updateMany` hardening; build a queue; touch M2 / M7 / M9.

## 11. Deferred: the queue

Not now. Current scale does not need it; Vercel Queues is in public beta; and
the migration, though low-risk, is real work.

Note that `connection_limit = 1` (Verified) *strengthens* the eventual case for
a queue: the only way to safely add write concurrency later is a bounded pool
(`connection_limit > 1`) **plus** a global throttle so a large backlog can't
open many connections at once. Vercel Queues' per-consumer-group max-concurrency
setting is exactly that throttle; the current `Promise.all`-over-5-sports design
has no equivalent. Until then, single-connection-serial writes are the ceiling
and the tuning levers in §9 only move the timeout/frequency around it.

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
   (headroom gone). Against the current 60 s cap that threshold is ~30 s;
   if `maxDuration` is later raised toward 800 s, re-anchor this to ~50% of
   whatever it is set to, and also watch the *absolute* trend.
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
