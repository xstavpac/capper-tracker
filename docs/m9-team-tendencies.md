# M9 — `recomputeTeamTendencies` unbounded per-sport history scan

**Status (2026-08-31):** Instrument first. The `select`-clause narrowing is done
now (free, semantics-preserving). No date bound, no rolling window, no seasonal
filter, no incremental accumulation — the repository evidence does not support
changing what these numbers mean. The larger fix (Option A below) is documented
as the long-term direction, **not implemented**, and touches the grading path so
it needs its own scoped approval.

**Epistemic tags**
- **Verified** — established directly from this repository.
- **[ESTIMATE]** — modeled from assumptions; not measured in production.
- **Unknown** — not available from anything inspectable right now.

---

## 1. Current implementation (Verified — traced in code)

`src/server/data/team-tendencies.ts` → `recomputeTeamTendencies(sportKey)`:

```
[gameResults, snapshots] = await Promise.all([
  prisma.gameResult.findMany({ where: { sportKey }, select: {5 cols} }),   // ALL finished games, this sport
  prisma.oddsSnapshot.findMany({ where: { sportKey }, select: { data } }), // ALL daily odds snapshots, this sport
])
oddsGames = snapshots.flatMap(s => s.data as OddsGame[])                   // every game in every snapshot, flattened

for (game of gameResults):
  oddsGame = findOddsGameForResult(oddsGames, game)   // same-teams + closest-by-commence-time; skip if none
  homePrice / awayPrice = moneylinePrice(oddsGame, team)
  if both present and not equal:                      // pick'em (equal ML) is excluded from fav/dog
     favTeam = lower American price
     tie score  → favPushes / dogPushes
     else       → favWins/favLosses + mirror dogLosses/dogWins
  line = totalLine(oddsGame)
  if line present:
     actual = homeScore + awayScore
     actual > line → overCount both teams
     actual < line → underCount both teams
     actual = line → totalPushCount both teams

await Promise.all( acc.entries().map(upsert TeamTendency row) )
```

- **No `where` date filter, no `orderBy`, no `take`, no `groupBy`, no season
  key.** Both `findMany` calls are scoped only by `sportKey`.
- **Sole caller:** `src/app/api/cron/refresh-scores/route.ts` (daily,
  `55 6 * * *`), once per sport in `RESOLVABLE_SPORT_KEYS` (5), in the sequence
  `persistFinalScores` → `recomputeTeamTendencies` → `snapshotTeamTendencies`.
  No page-load path calls it.
- **Downstream consumers of the `TeamTendency` / `TeamTendencySnapshot` output:**
  - `snapshotTeamTendencies` copies the live `TeamTendency` rows into a dated
    `TeamTendencySnapshot` row each run (cumulative running totals per day).
  - the model-engine tendency resolver and the Charts `tendencyProvider` read
    those snapshots.
  - `computeTendencyRates` converts the raw counts to display rates, gating each
    split on `MIN_TENDENCY_SAMPLE = 20` — a **sample-size floor, not a window**.

## 2. Semantic requirement — what the numbers are supposed to mean

**The calculation is all-captured-history (career / all-time over the data this
app has captured), by design. It is NOT season-to-date, trailing-N-games,
trailing-N-days, or a fixed sample.** Evidence:

1. Neither `findMany` has any date/season constraint — the only scope is
   `sportKey`.
2. The accumulator carries running totals (`favWins`, `overCount`, …) with no
   decay, no ring buffer, no per-season bucketing.
3. `snapshotTeamTendencies` snapshots the **cumulative** counts each day; the
   snapshot series is monotonically non-decreasing. A rolling window would make
   the series go down when old games age out — it never does.
4. `MIN_TENDENCY_SAMPLE = 20` is applied in `computeTendencyRates` as a
   *minimum* below which a rate is hidden — the opposite of a cap. The comment
   ties it to the other `*_MIN_SAMPLE` floors in the codebase.
5. The recompute-from-scratch-every-run design (rather than incremental) is
   justified in the function comment as *"cheap correctness insurance"* because
   `GameResult` / `OddsSnapshot` rows are immutable after creation — it assumes
   the full history is always in scope.
6. The comment on `GameResult.favTeam` / `totalLine` (the ledger fields) calls
   `lineSource` `"odds_snapshot"` = *"best-available daily cache"* — the same
   all-history source, not a recency-weighted one.
7. No product/model surface documents a "recent form" or "this season"
   requirement for team tendencies. The model-engine variable library treats a
   team's fav/dog/over/under rate as a stable trait.

**Conclusion: there is no correct date bound to add.** Any `WHERE gameDate >= …`
would silently change every downstream rate and every historical snapshot's
meaning. If a recency-weighted "form" metric is ever wanted, that is a **new
metric** alongside the career one, not a modification of this query.

## 3. The scale concern (M9)

Both `findMany` calls grow without bound as the app captures more history:

- `gameResult` rows: ~1–2k/sport/season → **[ESTIMATE]** ~10k rows/sport after
  ~5 seasons. Now narrowed to 5 small columns (see §4).
- `oddsSnapshot` rows: one per sport per day the fetch succeeds → ~200–300/
  sport/season. **Each `data` blob is the full day's odds board** (every game ×
  every bookmaker × every market) — the heavy part. `oddsGames` after
  `flatMap` is **[ESTIMATE]** tens of thousands of `OddsGame` objects after a
  few seasons, all held in memory, and `findOddsGameForResult` scans that array
  once per `gameResult` → **[ESTIMATE]** O(games × oddsGames) with a
  linear filter inside.

At current data volume this is trivial (runs once daily, off the request path).
The risk is multi-season accumulation making the daily cron slow or
memory-heavy. **Unmeasured** — the instrumentation added with this document is
the first source of real numbers.

## 4. Done now — `select` narrowing (Verified, semantics-preserving)

- `gameResult.findMany` now selects only
  `{ homeTeam, awayTeam, homeScore, awayScore, gameDate }` — the five columns
  the loop reads. This drops the three large per-game JSON blobs
  (`inningsJson` / `quartersJson` / `scoringPlaysJson`) and ~15 other unused
  columns from hydration.
- `oddsSnapshot.findMany` now selects only `{ data }` (`fetchDate` is not read
  by this function).

No behavior change — same rows, same computation, same output. Just less
row width pulled over the wire and hydrated by Prisma.

## 5. Instrumentation added now (measurement only)

`refresh-scores/route.ts` emits one `console.log` line per run:

```
{ tag: "refresh-scores-run", totalMs,
  sports: [ { sport, persistMs, tendencyMs, snapshotMs,
              gameResultRows, oddsSnapshotRows, oddsGamesFlattened,
              gamesProcessed, teamsUpdated } ] }
```

`recomputeTeamTendencies` returns the three new counts
(`gameResultRows`, `oddsSnapshotRows`, `oddsGamesFlattened`) alongside its
existing `gamesProcessed` / `teamsUpdated`. No extra query, no write, no
branching on the values. The per-sport `timing` block is also surfaced in the
JSON response body (additive).

These counts + `tendencyMs` are what decide **when** Option A becomes worth its
correctness cost.

## 6. Option A — the long-term fix (FUTURE, not implemented)

**Drop the `OddsSnapshot` scan entirely. Read the favorite and total line from
`GameResult.favTeam` / `GameResult.totalLine`** — the ledger fields already
persisted on every `GameResult` row by `persistFinalScores` →
`deriveLedgerFields` (migration `20260813003857`, column
`GameResult.lineSource = "odds_snapshot"`).

This removes the unbounded blob load and the O(games × oddsGames) matching —
the recompute becomes a single bounded `gameResult.findMany` + an in-memory
pass, with `favTeam` / `totalLine` read straight off each row.

**Why it is not a drop-in — 3 known divergences between `deriveLedgerFields`
(what populates the ledger fields) and `findOddsGameForResult` +
`moneylinePrice` / `totalLine` (what the recompute does today):**

1. **Same-day vs ±drift window.** `deriveLedgerFields` filters odds candidates
   to `sameEasternDay(commenceTime, referenceTime)`. `findOddsGameForResult`
   uses a `±MAX_GAME_TIME_DRIFT_MS` window (≈ ±6 h per the grading constant)
   and falls back to *all* same-team candidates if none are within drift. A
   game near midnight ET, or one whose snapshot `commenceTime` drifted from the
   final `gameDate`, can match under one rule and not the other → the ledger
   field can be `null` where the live recompute finds a line, or vice-versa.
2. **Pick'em handling.** The live recompute explicitly skips fav/dog
   accumulation when `homePrice === awayPrice` (true pick'em, no defined
   favorite) but still counts the over/under. `deriveLedgerFields` sets
   `favTeam` to `match.homeTeam` on the `homeOutcome.price < awayOutcome.price`
   test — an exact tie makes the strict `<` false, so `favTeam` becomes the
   **away** team rather than `null`. Reading `favTeam` blindly would
   mis-assign pick'em games to the away side.
3. **Backfill recovery.** `deriveLedgerFields` only runs
   `if (!existing || existing.favTeam === null)` — once a row has a `favTeam`
   it is never recomputed, even if a later, better odds snapshot arrives. The
   live recompute re-derives from the current `oddsGames` every run, so it can
   *improve* a match as more snapshots accumulate. Option A freezes each game's
   fav/line at first-capture quality.

**Prerequisites for Option A:**

- A one-time **backfill** of `GameResult.favTeam` / `totalLine` for historical
  rows where they are `null` (rows persisted before migration `20260813003857`,
  or where the same-day odds fetch was missed). Until backfilled, Option A
  would silently drop those games from the tendency counts.
- **Reconcile the 3 divergences** — decide, per divergence, whether the ledger
  field's rule or the live recompute's rule is the intended one, and make
  `deriveLedgerFields` and the recompute agree. This is a **grading-path
  change** (`deriveLedgerFields` lives in `grading.ts` and runs inside
  `persistFinalScores`), so it is **out of M9's scope** and needs its own
  approval.
- A migration-parity acceptance test proving the `GameResult`-only recompute
  produces the same `TeamTendency` counts as the `OddsSnapshot`-join recompute
  on a representative captured dataset.

## 7. Option B — bound the `OddsSnapshot` load only

Keep the join, but stop flattening every snapshot ever. Options:

- add `@@index` on `OddsSnapshot.sportKey` (there is only `@@unique([sportKey,
  fetchDate])` today) and page the scan;
- or narrow `oddsSnapshot` to snapshots whose `fetchDate` is within a few days
  of *some* `gameResult.gameDate` in the set — but the set spans all history,
  so this only helps if `gameResult` is itself bounded, which §2 says it must
  not be.

Option B reduces memory but keeps the O(games × oddsGames) matching and does
not remove the fundamental unboundedness. Lower value than A.

## 8. Option C — instrument, narrow `select`, decide later  ← **chosen now**

1. `select`-clause narrowing on both `findMany` calls (§4) — done.
2. `refresh-scores-run` instrumentation (§5) — done.
3. This document — done.
4. Acceptance tests locking in the all-history semantics
   (`src/server/data/team-tendencies-acceptance-test.ts`), including the
   **regression test that a 400-day-old `GameResult` MUST still be counted** —
   so a future accidental `WHERE gameDate >= …` fails CI. Done.

No semantic change. Revisit for Option A when a trigger below fires.

## 9. Triggers to revisit (do Option A)

Act when **any** is true, using the `refresh-scores-run` log line:

1. **`tendencyMs` for any sport consistently exceeds ~30 s** (the daily cron
   also does score persistence, stat snapshots, and decay-delta sync in the
   same invocation — a slow tendency phase eats the shared budget).
2. **`oddsGamesFlattened` for any sport crosses ~50,000** — the in-memory array
   and the per-game linear scan get expensive past roughly there
   (**[ESTIMATE]**; re-anchor once real `tendencyMs` is known).
3. **`refresh-scores` run `totalMs` approaches its function budget** (no
   explicit `maxDuration` on the route today → Vercel Pro default; if a
   `maxDuration` is later set, anchor to ~50% of it).
4. Memory pressure / OOM on the `refresh-scores` function in Vercel runtime
   logs.

## 10. Scope boundary for this pass

**Done:** `select` narrowing, instrumentation, this doc, the 6 acceptance tests.

**NOT done (needs separate approval):** Option A, any change to
`deriveLedgerFields` or the grading path, any date/season/window filter on the
tendency query, incremental accumulation, a `GameResult.favTeam` backfill,
schema/index changes, cron-schedule or `maxDuration` changes.
