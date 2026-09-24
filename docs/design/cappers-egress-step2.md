# /cappers list-page egress reduction — step 2 design

Status: **design only** — no implementation code, no migrations, no schema
changes. Scope is the `/cappers` **list page** only
(`src/app/(app)/cappers/page.tsx`). The capper detail page
(`/cappers/[capperId]`), its `computeCategoryBreakdown` call sites, the
units-over-time chart, and the T2 harness extension needed to cover the
detail page are all deferred to step 3.

This doc consolidates two accepted designs — Phase A (windowed record/streak
stats) and Phase B (category stats) — plus their verification plan, into one
reference before implementation starts.

## Why: the current call graph

`CappersPage` (`src/app/(app)/cappers/page.tsx:53-70`) issues, per page load:

- `Promise.all(SCORECARD_WINDOWS.map(w => getCapperLeaderboardTable(userId, w, { sportName: league })))` — **6 calls** (one per window: `TODAY, YESTERDAY, LAST_7, LAST_30, LAST_60, ALL`, `stats.ts:499`).
- `Promise.all(SCORECARD_WINDOWS.map(w => getFavoriteCappersSummary(userId, w)))` — **6 calls**.
- `getSportCategoryPanelData(userId, bestAtSport)` — **1 call**.

Every `getCapperLeaderboardTable` call fetches that request's **entire**
scoped pick history via `getCapperPickDataset` (`pick-aggregates.ts:20-28`,
`include: { sport: true }`, no `take`/limit — "Always full history" per its
own comment) and slices it into windows in JS
(`sliceIntoWindows`/`filterPicksByGameWindow`). `getFavoriteCappersSummary`
(`pick-aggregates-cappers-adapter.ts:108-125`) **itself** calls
`getCapperLeaderboardTable(userId, window)` (unscoped, to get `entries`) and
runs a second, independent `getCapperPickDataset` call for the pooled
favorites-only dataset. So the true count of full-history `getCapperPickDataset`
fetches per page load is:

| Source | Calls |
|---|---|
| Main leaderboard (`getCapperLeaderboardTable`, 6 windows) | 6 |
| Favorites summary → nested `getCapperLeaderboardTable` (unscoped, duplicates the main fetch) | 6 |
| Favorites summary → favorites-only dataset | 6 |
| Category panel (`getSportCategoryPanelData`) | 1 |
| **Total** | **19** |

This matches the previously-traced Phase A count exactly and is confirmed
directly against the code, not estimated.

## Phase A — windowed record/streak stats

### 1. Windowed FILTER-aggregate query

One query replaces the 6 per-window `getCapperPickDataset` calls behind the
main leaderboard. Instead of fetching every pick and slicing in JS
(`sliceIntoWindows`), it computes all 6 windows' aggregates in a single pass
using `FILTER (WHERE ...)`, grouped by capper:

```sql
SELECT
  p."capperId",
  -- repeated per window w in {TODAY, YESTERDAY, LAST_7, LAST_30, LAST_60}
  -- plus one unbounded ALL set (no gameTime bound, matching
  -- filterPicksByGameWindow's `if (window === "ALL") return picks;`
  -- short-circuit at stats.ts:532):
  count(*)      FILTER (WHERE p.status = 'WIN'  AND <w predicate>) AS w_wins,
  count(*)      FILTER (WHERE p.status = 'LOSS' AND <w predicate>) AS w_losses,
  count(*)      FILTER (WHERE p.status = 'PUSH' AND <w predicate>) AS w_pushes,
  coalesce(sum(<units_won_expr>) FILTER (WHERE p.status = 'WIN'  AND <w predicate>), 0) AS w_units_won,
  coalesce(sum(p.units)          FILTER (WHERE p.status = 'LOSS' AND <w predicate>), 0) AS w_units_lost,
  coalesce(sum(p.units)          FILTER (WHERE p.status IN ('WIN','LOSS') AND <w predicate>), 0) AS w_units_risked
FROM picks p
WHERE p."userId" = $1
  [AND p."sportId" IN (SELECT id FROM sports WHERE name = $2)]  -- only when filter.sportName is set
GROUP BY p."capperId"
```

36 aggregate columns (6 windows × 6 metrics) plus `capperId` — one row per
capper, not one row per pick. `<w predicate>` mirrors
`filterPicksByGameWindow` (`stats.ts:528-549`) exactly, per window:

- `TODAY`: `p."gradedAt" IS NOT NULL AND p."gameTime" >= $startOfEasternDay AND p."gameTime" < $now`
- `YESTERDAY`: `p."gradedAt" IS NOT NULL AND p."gameTime" >= $startOfEasternDay - interval '1 day' AND p."gameTime" < $startOfEasternDay`
- `LAST_7`/`LAST_30`/`LAST_60`: `p."gradedAt" IS NOT NULL AND p."gameTime" >= $now - interval 'N days' AND p."gameTime" < $now`
- `ALL`: no predicate at all — matches the JS short-circuit, which applies **no** `gradedAt` gate for `ALL` either. This is safe to replicate as-is: `computeStats` (`stats.ts:61-62`) and `currentStreak` (`stats.ts:110-112`) both independently filter on `status`, so a row with `gradedAt IS NULL` is always `PENDING`/`CANCELLED` and never contributes to any window's wins/losses/pushes/units regardless of this gate. Documented for parity, not because it changes output.

`$now` and `$startOfEasternDay` must be **computed once in the application
layer and passed as bound parameters**, exactly mirroring
`filterPicksByGameWindow`'s single `const now = new Date()` — not
recomputed per-window inside SQL (`now()`/`clock_timestamp()`), which would
risk a sub-millisecond boundary mismatch between windows and, more
importantly, between the old-JS and new-SQL implementations during the T2
harness diff (see Verification, item 3).

`<units_won_expr>` — the odds-guarded win-units expression (final decision:
zero-odds WINs count as 0 units, defensively, not `Infinity`):

```sql
CASE
  WHEN p.odds = 0 THEN 0
  WHEN p.odds > 0 THEN p.units * (p.odds / 100.0)
  ELSE p.units * (100.0 / abs(p.odds))
END
```

This is a **deliberate divergence** from current JS (`unitsWonOnBet`,
`stats.ts:33-36`, which produces `Infinity` or `NaN` at `odds = 0`) — see
"Non-reproducible behaviors" below. The live snapshot has zero `odds = 0`
rows today (`picks` table, checked below), so this never fires against real
data yet; it exists purely as a defensive floor. A **separate, small PR**
(not part of this step) adds a bulk-import guard rejecting `odds === 0` in
`src/server/actions/bulk-picks.ts`, matching the guard manual entry already
has (`src/server/actions/picks.ts:46`), so the zero-row count stays a
structural guarantee rather than an incidental fact about current data.

All computed money/percent columns (`w_units_won`, `w_units_lost`, plus the
derived `roi`/`winPct`/`weightedScore` computed from them) use **`float8`**,
not `numeric` — matching JS's own IEEE-754 float arithmetic
(`unitsWonOnBet`, `computeStats`) rather than introducing a second,
differently-rounding numeric representation. `winPct`, `roi`, and
`weightedRoiScore` (`stats.ts:241-245`) are **not** computed in SQL — they're
simple pure functions over the aggregate columns (`wins`, `losses`, `pushes`,
`netUnits`, `unitsRisked`) and stay in the application layer, run once per
row after the query returns, unchanged from today's logic.

### 2. Favorites derived from the same result

`getFavoriteCappersSummary` currently issues two more full-history fetches
per window (the nested unscoped `getCapperLeaderboardTable` call, plus its
own favorites-only `getCapperPickDataset` call). Both are eliminated:

- **`entries`**: filter the windowed-aggregate query's rows down to
  `isFavorite = true` cappers — the exact same rows the main leaderboard
  already computed, not a second query. When `filter.sportName` is set (a
  league pill is active), the main leaderboard's query is sport-scoped while
  favorites intentionally stays unscoped ("pools every favorited capper's
  picks across all sports," `cappers.ts:177-187`) — in that case, favorites
  needs its **own** unscoped run of the same query shape (2 queries total for
  that request). When no league pill is active (the default, most common
  load), the main leaderboard's query is already unscoped, so it **is** the
  same query — 1 query total, not 2.
- **`collectiveStats`**: sum the *raw* per-capper aggregate columns (wins,
  losses, pushes, `unitsWon`, `unitsLost`, `unitsRisked`) across the
  favorite-capper rows in the application layer, then recompute
  `winPct`/`roi` from the **summed numerators/denominators** — never average
  the per-capper `winPct`/`roi` values, which would be mathematically wrong
  (a 1-pick 100% capper and a 50-pick 40% capper do not average to 70%).
  `collectiveStats.currentStreak` is set to a fixed
  `{ type: "NONE", count: 0 }` placeholder: the existing code already
  documents this field as **not meaningful** on the pooled object and never
  read by the UI (`cappers.ts:169-172, 204-210`) — no computation needed.

### 3. Narrow streak query

`currentStreak` (`stats.ts:107-125`) is order-dependent — it walks a
window-scoped, chronologically-sorted list of decided (`WIN`/`LOSS`) picks
backward from the most recent until the status changes — so it cannot be
expressed as a `FILTER` aggregate. It's actively rendered
(`StreakBadge`, `cappers-leaderboard-table.tsx:222-234`, shown when
`count >= 2`), so amendment #4's drop of `longestWinStreak`/`longestLossStreak`
does **not** extend to `currentStreak` — that field stays in scope. It's
"narrow" because, unlike the FILTER-aggregate query (which must scan a
capper's full window-scoped history once to produce all 6 windows' counts),
computing it only needs a small ordered subset per `(capper, window)` pair:
the tail of that window's own decided picks.

Standard gaps-and-islands pattern, per `(capperId, window)`:

```sql
WITH ordered AS (
  SELECT
    status,
    "gameTime",
    sum(CASE WHEN status <> lag(status) OVER (ORDER BY "gameTime" DESC) THEN 1 ELSE 0 END)
      OVER (ORDER BY "gameTime" DESC) AS grp
  FROM picks
  WHERE "capperId" = $1
    AND status IN ('WIN', 'LOSS')
    AND <same w predicate as the FILTER-aggregate query, or none for ALL>
)
SELECT status, count(*) AS streak_count
FROM ordered
WHERE grp = 0
GROUP BY status
```

Zero rows back → `{ type: "NONE", count: 0 }`. Run per `(capperId, window)`
via a `LATERAL` join across the roster so it's one round trip, not `cappers ×
windows` separate queries. Each window's streak must be computed against
that window's own truncated pick set — a narrower window's streak is **not**
a prefix of the `ALL`-window streak (a loss just outside a 7-day cutoff still
breaks the all-time streak but is invisible to a 7-day-scoped computation),
so this can't be shortcut to one unbounded pass reused across windows;
confirmed by walking the actual `currentStreak` semantics in `stats.ts`, not
assumed.

Resolves amendment #1 (`picks.userId` scoping): `Pick.userId` is a real,
denormalized column (`prisma/schema.prisma:257`), confirmed directly against
the restored snapshot. No join through `cappers.userId` is needed anywhere
in Phase A — the streak query (and the FILTER-aggregate query) filter
`WHERE "userId" = $1` directly, same as every other query in this design.

`getMostActiveThisWeek` (`cappers.ts:227-259`) is untouched — it's a pure
`datePosted`-based volume count with no window/category shape, unaffected by
either phase, per the "category branch out of scope" decision below.

## Phase B — category stats

### 4. Where the CASE lives

New module `src/server/data/pick-category-sql.ts`: one `Prisma.sql` CASE
fragment covering every branch of `pickCategory` that's derivable from
stored columns alone — `NRFI`/`YRFI` (text match), `MONEYLINE` (odds/side
sign), `SPREAD` (line sign, excluding `line IS NULL`), `TEAM_TOTAL`
(constant), `TOTAL` (`betDetail` text match), and `PLAYER_PROP` only when
`propMarket IS NOT NULL` (direct enum read → `'TD_PROP'`, today's only real
`propMarket` value). Every row the CASE can't resolve from columns alone —
`SPREAD` with `line IS NULL`, `PLAYER_PROP` with `propMarket IS NULL` — falls
to a `'__JS__'` sentinel.

Reused in both a `GROUP BY` and a chip-filter `WHERE`, via a CTE (Postgres
can't reference a `SELECT` alias in that same query's `WHERE`):

```sql
WITH categorized AS (
  SELECT p.*, <CASE_FRAGMENT> AS category
  FROM picks p
  WHERE p."userId" = $1
)
SELECT category, <aggregates>
FROM categorized
WHERE category IS NOT NULL [AND category = $2]  -- chip filter, when present
GROUP BY category
```

### 5. Sentinel merge path

Narrow query, run alongside the categorized query:

```sql
SELECT * FROM picks
WHERE "userId" = $1
  AND (
    ("betType" = 'SPREAD' AND "line" IS NULL)
    OR ("betType" = 'PLAYER_PROP' AND "propMarket" IS NULL)
  )
```

Field names confirmed against `prisma/schema.prisma` (`line Float?` at
line 271, `propMarket PropMarket?` at line 304). Live-snapshot sizing: of
1,242 `SPREAD` rows, 18 have `line IS NULL`; the snapshot has **zero**
`PLAYER_PROP` rows at all, so that branch is only ever exercisable via
synthetic fixtures (see Verification, item 4, and "Non-reproducible
behaviors" below).

Merge mechanics: **two aggregate maps summed in JS**, not a `UNION ALL` with
a JS-derived values table. The sentinel query returns a handful of raw rows
per user; running the existing `pickCategory()` JS function on just those and
folding the `{wins, losses, pushes, unitsWon, unitsLost}` result into the
SQL-side `GROUP BY category` map (keyed the same way) is simpler and avoids
pushing `parsePlayerProp`'s regex-based free-text disambiguation into SQL,
which has no reasonable translation (see "Non-reproducible behaviors").
`winPct`/`roi` are recomputed from the merged raw sums, never averaged.

For `computeSpecialistTag`: needs every category's share of a capper's
**total** decided volume. The SQL `GROUP BY` gives the SQL-derived
categories; the sentinel JS pass adds its categories on top into the same
map; `totalDecided` is a third, separate, simple
`COUNT(*) WHERE status IN ('WIN','LOSS','PUSH')` (no category grouping
needed) rather than re-derived from the two partial maps. Thresholds
(`SPECIALIST_CONCENTRATION_THRESHOLD = 0.5`, `RANKING_MIN_SAMPLE = 5`,
`stats.ts:1143, 225`) apply exactly as today.

For per-category leaderboards (`getSportCategoryPanelData`): the same merge,
grouped by `(capperId, category)` instead of just `category` — SQL side
groups by that composite key, and the sentinel-path JS aggregation groups by
the same key before the two maps are merged.

## Consumer map (`/cappers` list page only)

| Consumer | Current path | New path |
|---|---|---|
| `getCapperLeaderboardTable` (6 windows) | 6× full-history fetch + JS slice | 1–2× windowed FILTER-aggregate query (item 1) + 1× narrow streak query (item 3) |
| `getFavoriteCappersSummary` (6 windows) | nested `getCapperLeaderboardTable` + own full-history fetch, ×6 | derived from the same aggregate-query rows (item 2) — no additional query in the common (no-league-pill) case |
| `getSportCategoryPanelData` | full-history fetch + JS `computeCategoryBreakdown` + JS per-category grouping | categorized CTE + `GROUP BY (capperId, category)` (item 4) + sentinel merge (item 5) |
| `getMostActiveThisWeek` | own `datePosted`-scoped `findMany`, unrelated shape | **unchanged** — out of scope (see below) |

**Out of scope, confirmed unaffected by call-site evidence:**

- `getCapperCategoryRecord`/`getCapperCategoryRecords` (`picks.ts:385-456`) — used by `sharp-money.ts:107`, `parlay-generator.ts:69`, `parlay-pool-generator.ts:113`, and `/live`'s game-card expander; **never** by `/cappers`. Not migrated.
- `sharp-money.ts:93`, `live-board-picks.ts`, `duplicate-pick-detection.ts`, `qualification-ranking.ts:200` — all call `pickCategory` directly, none touch `/cappers` code. Stay on JS unchanged.
- **Category chip filter** (`CapperLeagueFilter.category`) and `getMostActiveThisWeek`'s category branch — plumbed through the types but **no route currently sets `filter.category`**; `cappers/page.tsx` only ever passes `{ sportName: league }`. Left on the existing JS path untouched; not built in this step.
- Parlays — out of scope. No schema changes, no backfill, in either phase.
- `/cappers/[capperId]`'s three `computeCategoryBreakdown` call sites, the units-over-time chart, and momentum/odds-range/consistency computations — deferred to step 3.

## Verification

### T2 harness

`run-diff.mjs`'s existing disposable-DB restore → capture → diff → drop
cycle (`scripts/t2-harness/run-diff.mjs`) applies directly. Add a `t4` entry
to `capture-output.ts`'s `IMPLEMENTATIONS` registry for the new
Phase A+B module; diff **`impl-old=t3`** (the current production path,
`pick-aggregates-cappers-adapter.ts`, live since the T5 cutover per that
file's own header comment) against **`impl-new=t4`** — not `old` (legacy
pre-T3), which is no longer what production runs. This follows the same
T-numbered rollout convention already used for T3→T5 (build → harness-diff
→ cutover → observation period → old-code removal).

`deep-diff.mjs`'s `deepDiff` currently does exact `===` equality at every
leaf. Per the accepted tolerance: round any leaf whose path ends in a
money/percent field name (`winPct`, `roi`, `netUnits`, `unitsWon`,
`unitsLost`, `weightedScore`) to 2 decimals before comparing (matching
`round2` and the UI's own display rounding); every other leaf (counts, ids,
category keys, streak type/count, booleans, ordering) stays exact.

Every new query needs an **explicit `ORDER BY`** matching the current JS
sort — `GROUP BY` has no defined row order, and the JS implementation relies
on JS-side re-sorting rather than any DB-level order today, so an unordered
new query would produce false-positive harness diffs on row order alone,
not real behavioral differences.

### Unit tests

A dedicated acceptance-test file (matching the existing convention —
`pick-aggregates-cappers-adapter-acceptance-test.ts` is the closest analog)
running both the real `pickCategory()`/`computeStats`/`currentStreak` JS
functions and the equivalent raw SQL against synthetic rows in a disposable
test DB, asserting the two outputs match. Minimum required cases:

- `PLAYER_PROP` with `propMarket = 'TD'` set → both paths resolve `'TD_PROP'` directly, without the sentinel query ever selecting the row.
- `PLAYER_PROP` with `propMarket = NULL` and a parseable `betDetail` (e.g. "Puka Nacua Anytime TD") → SQL emits the sentinel, the sentinel query selects the row, JS `pickCategory` resolves it via `parsePlayerProp`, and the merged output matches plain unmodified JS.
- `PLAYER_PROP` with `propMarket = NULL` and unparseable `betDetail` → both paths resolve to excluded/null, matching `parsePlayerProp`'s documented behavior.
- `SPREAD` with `line = NULL` → sentinel path, JS fallback via the existing odds-sign heuristic.
- `odds = 0` on a `WIN` row → SQL's guarded `units_won` must equal the defensive `0` (not JS's `Infinity`/`NaN`) — this is the one case the unit test asserts a **deliberate divergence**, not parity, and should say so in the test's own comment.
- `currentStreak`: a synthetic run of picks straddling a window boundary (e.g. a loss just outside `LAST_7` that would break an all-time streak but must not affect the `LAST_7`-scoped streak) — asserts the per-window streak query, not a shared/prefix computation.

## Reconciled egress estimate

The earlier Phase B draft's "~2.3MB, 2 fetches" figure was **wrong** — it
only traced `getSportCategoryPanelData`'s single call and missed 18 of the
19 actual per-page-load fetches (the nested `Promise.all` across all 6
`SCORECARD_WINDOWS` in `page.tsx`, and the nested `getCapperLeaderboardTable`
call inside `getFavoriteCappersSummary` that duplicates the main leaderboard
fetch again). The call-graph re-trace above confirms the previously-traced
count of **19 full-history fetches** is correct.

Measured directly against the checked-in anonymized snapshot
(`scripts/t2-harness/.snapshots/prod_2026_09_15.dump`, restored to a
disposable local DB via the harness's own mechanism, queried read-only, then
dropped):

- 4,984 total `picks` rows across the snapshot.
- Heaviest account: 4,291 total picks, 110 cappers on the roster, 25
  favorited cappers (1,370 picks belong to them), 3,111 picks in MLB (the
  default `bestAtSport` used by the category panel).
- `pg_column_size` per `picks` row (raw table, no join): avg 274.5 bytes.
- `pg_column_size` per `picks` row **joined to its `sports` row**
  (`getCapperPickDataset`'s actual `include: { sport: true }`): avg 325.7
  bytes — the relation join `getCapperPickDataset` always performs adds
  ~51 bytes/row on top of the raw table.

**Before**, for the heaviest account on the default ("All leagues") view —
6 main-leaderboard calls × 4,291 picks + 6 nested-favorites-leaderboard calls
× 4,291 picks (unscoped, same size as main when no league pill is active) +
6 favorites-only calls × 1,370 picks + 1 category-panel call × 3,111 picks =
**62,823 pick-rows fetched** (with the sport join) in one page load, for one
user. At 325.7 bytes/row: **≈ 20.5 MB** of Postgres→app-server egress on a
raw-column-size basis. This is a compact lower bound — actual bytes
transferred over Postgres's text wire protocol plus Prisma's JS object
materialization run measurably higher than `pg_column_size` for text-format
columns, which is consistent with (not contradicting) the previously-traced
~25MB figure; both derivations agree on the same 19-call structure and the
same order of magnitude, differing only in measurement basis.

**After**: the FILTER-aggregate query returns one row per capper — 110 rows
for the heaviest account, not 62,823. At ~36 `float8` aggregate columns
(~288 bytes) plus a `capperId` per row, that's roughly 110 × ~310 bytes ≈
34 KB for the common (no-league-pill) case, up to double that (~68 KB) when
a league pill requires the sport-scoped and unscoped variants as separate
queries. The streak query adds 110 cappers × 6 windows ≈ 660 small rows
(tens of KB). The category panel (Phase B) returns at most
`110 cappers × ~15 category keys` aggregate rows for MLB's chip set, plus a
sentinel query that returns at most a handful of rows (18 systemwide in the
real snapshot, 0 for `PLAYER_PROP`) — also tens of KB. **Total: well under
200 KB** for the heaviest account, versus ~20–25 MB today — better than a
99% reduction, and the gap widens over time: the new design's egress scales
with roster size × window count × category count (all small, slow-growing),
while today's design scales linearly with total historical pick volume
(unbounded, growing with every future pick).

## Non-reproducible behaviors

- **`parsePlayerProp`'s free-text market parser** (`bet-line.ts:466-541`,
  multi-market regex disambiguation with connector-word and player-name
  handling) has no reasonable SQL translation — this is exactly why it stays
  permanently behind the sentinel, not a future migration candidate.
- **`odds = 0` units-won**: SQL returns `0`; JS today would return
  `Infinity`/`NaN`. Deliberate, accepted divergence (see item 1) — safe only
  because bulk import gets its own guard in a separate small PR to keep this
  case at zero real rows going forward.
- **`float8` vs `numeric` rounding**: JS does IEEE-754 float arithmetic;
  choosing `float8` for the new columns (per the accepted decision) minimizes
  divergence at the source, but the 2-decimal display-rounding tolerance in
  the T2 diff still absorbs any last-digit difference that remains.
- **Result ordering**: `GROUP BY` has no defined order; every new query
  needs an explicit `ORDER BY` matching the current JS sort, or the harness
  will report false-positive diffs that are really just row-order noise.
- **`PLAYER_PROP` sentinel coverage against real data**: the current prod
  snapshot has zero `PLAYER_PROP` rows, so a T2 harness diff against it
  reports "no differences" for that branch regardless of whether the
  sentinel merge is actually correct — real confidence there comes only from
  the synthetic unit tests in Verification, item 2, not from the snapshot
  diff.
- **Live-clock boundary races**: `TODAY`/`YESTERDAY`/rolling windows are
  bounded by `new Date()` captured once per request. This is a pre-existing
  property of the current JS implementation (not introduced by this design)
  — but the T2 harness's `impl-old`/`impl-new` capture calls run as two
  separate sequential child processes (`run-diff.mjs:81-103`), so a request
  that straddles a window boundary between those two captures could show a
  false-positive diff unrelated to the SQL migration itself. Worth a note in
  the harness run's own output if a diff appears right at a window edge.
