# `fetchPicksByCapper` egress reduction — design

Status: **design only** — no implementation code, no migrations, no schema
changes, no production access. Scope is `fetchPicksByCapper`
(`src/server/data/picks.ts:415`) and its two callers,
`getCapperLeagueRecords` (`:495`) and `getCapperCategoryRecords` (`:429`).
Same shape as `docs/design/cappers-egress-step2.md` (which did this for the
`/cappers` list page in #123/#125); this doc reuses that work wherever it can.

Epistemic tags used throughout: **Verified** (read in the repo at
`189d5fc`), **[ESTIMATE]** (modeled from the numbers in the step-2 doc, not
measured), **[UNVERIFIED]** (believed true, needs a check named in the text).

## 1. Why: what runs today

`fetchPicksByCapper(userId, capperIds)` does one Prisma
`pick.findMany({ where: { userId, capperId: { in } }, include: { sport: { select: { name } } } })`
and returns **every column of every pick** those cappers ever made, unbounded.
The callers then compute, per capper, in JS:

| Caller | What it derives from the full history |
|---|---|
| `getCapperLeagueRecords` | league cards (`computeLeagueRecordCards`), current streak (`computeStats(...).currentStreak`), last-20 (`recentPicksRecord`) |
| `getCapperCategoryRecords` | one `CategoryBreakdownItem` per requested (capper, category) (`computeCategoryBreakdown`) |

Call sites (Verified by grep):

| Surface | Path | Calls per trigger |
|---|---|---|
| Grid Live game panel | `team-picks-panel.tsx` `TeamPickSection` ×3 (away / home / other) → `getLeagueRecordsAction` | up to **3** per game switch (a section with 0 picks skips its call) |
| Live standard expander | `game-picks-expander.tsx:123` → `getLeagueRecordsAction` | 1 per expand |
| Parlay Pool (records for cards) | `parlay-pool-section.tsx:259` effect on `poolKey` → `getLeagueRecordsAction` | 1 per pool membership change |
| Parlay Pool "My Picks" build | `parlay-pool-section.tsx:294` → `getLeagueRecordsAction` | 1 per build click |
| Auto-Generate | `parlay-generator.ts:64` → `getCapperLeagueRecords` **and** `getCapperCategoryRecords` in `Promise.all` | 2 per click |
| Hedge / Contrarian (pool) | `parlay-pool-generator.ts:64, 113, 126` | **3** sequential per click, per mode |
| Sharp Money | `sharp-money.ts:107` → `getCapperCategoryRecords` | 1 per page load |

`getCapperCategoryRecord` (singular, `picks.ts:385`) has no caller outside
`picks.ts` and is a wrapper over the plural; it is migrated for free.

### 1.1 Correction to the "single raw fetch" premise

The current path is **not** one statement. `@prisma/client` is `^5.20.0`,
`prisma/schema.prisma` has no `relationJoins` preview feature, and no code sets
`relationLoadStrategy`, so `include: { sport }` uses Prisma 5's default
`query` strategy: one `SELECT … FROM picks …` followed by one
`SELECT … FROM sports WHERE id IN (…)`. **[UNVERIFIED]** against a query log —
the harness run in §8 should enable Prisma's `log: ["query"]` and confirm. If
true, the baseline is **2 sequential DB round trips per call**, and every
"today" round-trip number below counts 2 per `fetchPicksByCapper`.

## 2. Every field every consumer reads

Consumer reads, traced to the reading code (Verified):

### 2.1 `CapperLeagueRecords` (from `getCapperLeagueRecords`)

| Field | Read by | Fields actually used |
|---|---|---|
| `records[capperId\|leagueSport\|category]` → `LeagueRecordCard \| null` | `pick-card.tsx:115`, `lib/parlay/pick-record.ts:27` | `card.overall.{wins,losses,pushes,winPct,count}`, `card.league.{same}`. `card.label` / `card.category` are **not** read by any consumer (label is `PICK_CATEGORY_LABELS[key]`, derivable in the app). |
| `streaks[capperId]` → `{type, count}` | `pick-card.tsx:116` → `gameCardStreakGlyph` / `StreakRow` | `type` ∈ WIN/LOSS/NONE, `count` (rendered only when `count >= 2`, but the value is passed through unmodified). |
| `last20[capperId]` → `LeagueRecordColumn \| null` | `pick-card.tsx:117`, `pick-record.ts:37` | `wins, losses, pushes, winPct, count`. |

`bestAvailableRecord` (`pick-record.ts`) falls back league → overall → last20 by
testing `card.league.count > 0`, `card.overall.count > 0`, `last20.count > 0`,
and reads `wins, losses, winPct`. `PickCard` also uses `card.league.winPct >=
TOP_PERFORMER_THRESHOLD` and `card.overall.count > 0`.

### 2.2 `CategoryBreakdownItem` (from `getCapperCategoryRecords`)

| Consumer | Fields read |
|---|---|
| `sharp-money.ts:114-131` | `winPct` (gate `< QUALIFYING_WIN_PCT`), then `wins, losses, pushes, winPct` |
| `qualification-ranking.ts:90, 206` (Hedge/Contrarian/Auto-Generate via `buildSwapParlay` → `rankCandidates`) | `qualifies`: `winPct >= 55`; then `wins, losses, winPct` |

**`item.recent` has no reader.** `getCapperCategoryRecords` passes
`recentForm: { window: 20, minSample: 100 }` (`picks.ts:444`), which attaches
`recent` to any category with ≥100 decided picks, but a repo-wide grep for
`.recent` finds no consumer (its own comment names `game-picks-expander.tsx` as
the reader, which now uses `getLeagueRecordsAction` and never sees this type).
`label` and `key` are also unread by these two consumers. Recommendation and
open question Q3: **drop `recent`** from the new path.

### 2.3 The exact logic being reproduced

Status handling, common to everything below. `PickStatus` is
`PENDING | WIN | LOSS | PUSH | CANCELLED` — **there is no `VOID`**.

| Status | Record counts (`computeStats`, `stats.ts:61`) | Streak (`currentStreak`, `:143`) | Last-20 (`recentPicksRecord`, `:1314`) |
|---|---|---|---|
| `WIN` | wins++ | counted | counted |
| `LOSS` | losses++ | counted | counted |
| `PUSH` | pushes++ | **skipped — does not break a streak** (filtered out before the walk) | counted, and consumes one of the 20 slots |
| `PENDING`, `CANCELLED` | skipped (`continue`) | skipped | skipped |

Consequence: **every consumer reads only decided (`WIN`/`LOSS`/`PUSH`) rows;
no field depends on a `PENDING`/`CANCELLED` row.** The SQL therefore filters
`status IN ('WIN','LOSS','PUSH')` once in a shared CTE and never sees the rest.
No `gradedAt` predicate applies anywhere (unlike the `/cappers` windows):
`computeStats` gates on `status` only.

Per output field:

- **`overall` / `league` columns** (`computeLeagueRecordCards` `:1429` →
  `computeCategoryBreakdown` `:1336` → `computeStats`): group by
  `pickCategory(pick)`; a `null` category is dropped (`if (!key) continue`);
  keep only keys in the caller's `order` list (`ALL_CATEGORY_KEYS`); drop a
  category whose `wins+losses+pushes == 0` (`.filter(count > 0)`).
  `winPct = wins/(wins+losses)*100`, unrounded, 0 when no decisions
  (`winPctOf`, `:131`); `count = wins+losses+pushes`. `league` uses the same
  computation over `picks.filter(p => p.sport.name === leagueSportName)`
  (exact, case-sensitive) and falls back to an all-zero column when the
  category has no card there. **A card exists iff the overall count > 0**;
  otherwise `records[key]` is `null`.
- **`streaks[capperId]`**: `computeStats(allPicks).currentStreak` =
  `currentStreak(sorted-by-gameTime-asc)`: filter to `WIN`/`LOSS`, take the last
  one's status, count the trailing run of that status. `{NONE, 0}` when the
  capper has no `WIN`/`LOSS`.
- **`last20[capperId]`**: `null` when the capper has `< 20` decided
  (`W/L/P`) picks; else sort decided by `gameTime` **desc**, take 20, and
  `computeStats` them → `wins, losses, pushes, winPct, count = w+l+p`.
- **`CategoryBreakdownItem`** (`getCapperCategoryRecords`): the same
  `computeCategoryBreakdown` output as `overall` above, looked up by
  `capperId|category`; `null` for a pair with no card.

**No money field is read by any consumer** (`unitsWon`, `roi`, `netUnits`
never leave `computeStats` into these shapes). That removes the float-ordering
and `odds = 0` (`Infinity`/`NaN`) concerns the `/cappers` migration had to
carry: every value here is an integer count or `winPctOf(wins, losses)` of
integer counts.

## 3. Stored `Pick.category` in place of runtime `pickCategory()`

Plan: `GROUP BY` / `WHERE p.category = …` on the stored column, exactly as
`querySpecialistCandidates` / `queryCategoryPanel` already do since #125.

### 3.1 Evidence, and where it stops

| # | Claim | Evidence | Limit of the evidence |
|---|---|---|---|
| E1 | Every row is stamped by `pickCategory()` at create | `subscriptions.ts:200-216` calls `pickCategory({ betType, period ?? "FULL_GAME", betDetail, odds, line, sportName, pickedSide, mlFavoredSide, propMarket })` and stores `category` + `categoryVersion`; it is the only `pick.create` in `src/` (grep: `pick.create*` matches only `subscriptions.ts:216`). The read path (`computeCategoryBreakdown`) passes `{...pick, sportName: pick.sport.name}` — the same nine inputs, from the same columns. | **Out-of-band creators bypass it**: `prisma/seed-dev.ts`, the historical `.scratch-reinsert-recovery.mjs` (both listed in `cache-invalidation-contract.md` P10/P11), and **`scripts/t2-harness/fixtures.ts:181`** (creates picks with no stamp → `categoryVersion = 0`, `category = NULL`). Not prod paths, but see §8. |
| E2 | Nothing rewrites a category input after insert | Grep of every `pick.update / updateMany / upsert` in `src/`: `picks.ts:97` (`status`, `gradedAt`), `grading.ts:1138` and `:1178` (`status`, `gradedAt`, `gradedViaFuzzyMatch`), `cappers.ts:463` (`capperId` only — not an input), `backfill-pick-category.ts:80` (`category`, `categoryVersion`). No `$executeRaw` anywhere in `src/`; `sport.*` writes are `sport.create` only (`bulk-picks.ts:569`), so a `Sport.name` (an input via `sportName`) is never renamed by the app. | **App code only.** Manual SQL in the Supabase console or a future migration is not covered. The only migration that ever updated `picks` (`20260807092454_add_pick_graded_at`) touched `gradedAt`. |
| E3 | Drift is caught in CI | `pick-category-version-acceptance-test.ts` pins `pickCategory` for a matrix of inputs (fails if an output changes without bumping `PICK_CATEGORY_VERSION`); `backfill-pick-category-acceptance-test.ts` asserts every stamped row equals `pickCategory(row)` at the current version and that null-category rows are stamped; `capper-list-aggregates-acceptance-test.ts:623/703` assert the stored category is authoritative and the write path stamps `pickCategory(row)`. | **The golden matrix is a finite sample.** A change to `pickCategory` — or to a helper it calls (`favoriteOrUnderdog`, `extractLine`, `nrfiSide`, `parsePlayerProp` in `bet-line.ts`) — on an input the matrix does not contain leaves stored values stale with no failing test. The version bump is a manual discipline. |
| E4 | Production is fully stamped | Reported check: `categoryVersion < 1` returned **0** on 2026-09-28 (after #124 fixed the batch-boundary skip that had left 13 rows). I did not re-run it (no prod access in this task). | It proves **no row is unstamped at that instant**. It does **not** prove the stored value *equals* `pickCategory(row)` (the backfill wrote what the code computed at that time, but nothing compared stored-vs-recomputed afterwards), nor that rows created since are stamped. |

### 3.2 Gaps flagged

- **G1 — no stored-vs-recomputed check on production data.** E4 is a
  completeness check, not a correctness check. Propose a read-only
  `--verify` mode on `scripts/backfill-pick-category.ts`: over **all** rows
  (not just `categoryVersion < current`), select the same nine input columns,
  recompute `pickCategory`, and report counts of `stored == recomputed`,
  `stored != recomputed` (with up to N sample ids and the differing pair), and
  `categoryVersion < current`. The user runs it against production (it
  performs no writes) and I run it against the restored snapshot. **Gate: it
  must report zero mismatches before the SQL path is switched on.** Re-run the
  `categoryVersion < 1` count in the same session.
- **G2 — the golden matrix is a sample** (E3). Propose a second, exhaustive
  parity test: enumerate the cross-product of `betType × period × sportName
  {MLB, NFL, NBA, NHL, NCAAF, …} × odds sign {-,+,0} × line {null, <0, 0, >0} ×
  betDetail variants {null, over/under text, NRFI/YRFI text, "Game 2" text,
  garbage} × pickedSide/mlFavoredSide combinations × propMarket {null, TD}`,
  run `pickCategory`, and compare against a checked-in expected-output file
  (JSON). Any output change fails CI and forces the version bump, for the whole
  matrix rather than a hand-picked sample. (This strengthens E3; it does not
  replace G1, which checks real rows.)
- **G3 — `ALL_CATEGORY_KEYS` completeness is true but untested.** JS drops any
  category not in `ALL_CATEGORY_KEYS` (`computeCategoryBreakdown`'s `order`
  filter). By reading `stats.ts` (`MLB_CHIP_SET` ∪ `SPREAD`, `FIRST_HALF_*`,
  `TD_PROP` ∪ `SEGMENT_CATEGORY_KEYS`), every `PickCategoryKey` union member is
  in it today. Nothing enforces that. Propose a one-line test: every key of
  `PICK_CATEGORY_LABELS` is in `ALL_CATEGORY_KEYS`. The new SQL only ever
  compares against the *requested* categories (which come from JS
  `pickCategory` at the call site), so it surfaces no stored key that JS would
  have dropped — but the test keeps that true.
- **G4 — stamping is not enforced at write time for future creators.** Any new
  code path (or script) that creates a pick without `createPicksWithEntitlementCheck`
  produces `categoryVersion = 0`, and the new SQL would then silently omit that
  pick from every category/league card (silently wrong beats unresolved in
  severity — see the project's bad-data-vs-unresolved rule). #125 deliberately
  removed the equivalent fallback for `/cappers`; this doc does **not** propose
  bringing back a JS fallback. It proposes a **detection-only tripwire** that
  costs no round trip: the shared CTE also computes
  `count(*) FILTER (WHERE "categoryVersion" < $current)` over the requested
  cappers' decided rows, and the wrapper `console.error`s (→ log drain) when it
  is `> 0`. See Q2.

### 3.3 Sub-case: `NULL` category

`pickCategory` legitimately returns `null` (e.g. a `TOTAL` with no over/under
text). Stored as `category = NULL, categoryVersion = 1`. The SQL matches
`p.category = <requested key>`, which is never true for `NULL`, reproducing
JS's `if (!key) continue`. `NULL`-category rows still count toward **streak**
and **last-20**, which are category-independent (as in JS, where they operate
on the whole history).

## 4. Proposed SQL

All queries scope `WHERE p."userId" = $userId AND p."capperId" IN (…)` and use
the existing `(userId, capperId)` index. They read decided rows only (§2.3).

### 4.1 Ordering (a deliberate behavioral stabilization)

Today the JS path has **no defined order**: `findMany` has no `orderBy`, and
`computeStats` / `recentRecordColumn` sort by `gameTime` alone with a stable
`Array.sort`, so two picks with the same `gameTime` keep whatever order Postgres
returned them in. Same-`gameTime` picks are common (a capper posts several bets
on one game), so this is not a corner case.

Proposal: one canonical chronological total order everywhere,

```
gameTime ASC, createdAt ASC, id ASC COLLATE "C"      -- "ORDER"
gameTime DESC, createdAt DESC, id DESC COLLATE "C"   -- "ORDER_DESC" (exact reverse)
```

matching `ORDER` / `ORDER_DESC` in `capper-list-aggregates.ts:93-94` (#123).
Streak = the tail of `ORDER`; last-20 = the last 20 rows of `ORDER` (i.e. the
first 20 of `ORDER_DESC`).

**This is a behavior change** in exactly two places, and only when a tie in
`gameTime` straddles the boundary that matters:

1. **Streak**: a tie at the streak's edge between a `WIN` and a `LOSS` picks
   the later-created one as "last". Today: physical row order (probably
   insertion order, so *usually* the same result — **[UNVERIFIED]**).
2. **Last-20 cutoff**: the 20th/21st decided picks tie on `gameTime`. Today the
   desc sort is stable over physical order, so ties come out **oldest-inserted
   first** and the cut keeps the oldest-inserted of the tied group; the
   proposal keeps the **newest-created** (the reverse), consistent with
   defining "most recent" by one order. This can differ from today's *typical*
   result even when heap order is insertion order. It is the more defensible
   definition, and it is the one #123 already adopted for streaks.

Nothing else changes: record counts are order-independent.

### 4.2 One statement, one round trip

Reads go through `prisma.$queryRaw` (already how #123 works under
`pgbouncer=true`). One statement builds a shared, once-scanned base and derives
every part from it, returning **one row, one `jsonb` column** (parsed in JS).

```sql
WITH
  ids(cid) AS (VALUES ($cid1), ($cid2), …),           -- every capper in the request
  base AS MATERIALIZED (                              -- scan picks ONCE
    SELECT p."capperId" AS cid, s.name AS sport, p.category,
           p.status, p."categoryVersion" AS cv,
           p."gameTime" AS gt, p."createdAt" AS ca, p.id
    FROM picks p
    JOIN sports s ON s.id = p."sportId"
    WHERE p."userId" = $userId
      AND p."capperId" IN (SELECT cid FROM ids)
      AND p.status IN ('WIN', 'LOSS', 'PUSH')
  ),

  -- league cards: one row per requested (capper, league, category)
  req(cid, sport, cat) AS (VALUES ($c, $l, $k), …),   -- DISTINCT, categories pre-validated ∈ ALL_CATEGORY_KEYS
  cards AS (
    SELECT r.cid, r.sport, r.cat,
      count(*) FILTER (WHERE b.status = 'WIN')                          AS o_w,
      count(*) FILTER (WHERE b.status = 'LOSS')                         AS o_l,
      count(*) FILTER (WHERE b.status = 'PUSH')                         AS o_p,
      count(*) FILTER (WHERE b.status = 'WIN'  AND b.sport = r.sport)   AS l_w,
      count(*) FILTER (WHERE b.status = 'LOSS' AND b.sport = r.sport)   AS l_l,
      count(*) FILTER (WHERE b.status = 'PUSH' AND b.sport = r.sport)   AS l_p
    FROM req r
    LEFT JOIN base b ON b.cid = r.cid AND b.category = r.cat
    GROUP BY r.cid, r.sport, r.cat
  ),

  -- category records: one row per requested (capper, category) — overall only
  creq(cid, cat) AS (VALUES ($c, $k), …),
  catrec AS (
    SELECT q.cid, q.cat,
      count(*) FILTER (WHERE b.status = 'WIN')  AS w,
      count(*) FILTER (WHERE b.status = 'LOSS') AS l,
      count(*) FILTER (WHERE b.status = 'PUSH') AS p
    FROM creq q
    LEFT JOIN base b ON b.cid = q.cid AND b.category = q.cat
    GROUP BY q.cid, q.cat
  ),

  -- current streak (gaps-and-islands; same shape as queryCurrentStreaks, window = ALL)
  d AS (
    SELECT cid, status::text AS st,
      row_number() OVER (PARTITION BY cid ORDER BY gt DESC, ca DESC, id COLLATE "C" DESC) AS rn
    FROM base WHERE status IN ('WIN', 'LOSS')
  ),
  streaks AS (
    SELECT d.cid, lead.st AS type,
      COALESCE(min(d.rn) FILTER (WHERE d.st <> lead.st) - 1, count(*))::int AS count
    FROM d JOIN d lead ON lead.cid = d.cid AND lead.rn = 1
    GROUP BY d.cid, lead.st
  ),

  -- last 20 over ALL decided rows (PUSH included), gated at 20 decided
  r AS (
    SELECT cid, status,
      row_number() OVER (PARTITION BY cid ORDER BY gt DESC, ca DESC, id COLLATE "C" DESC) AS rn
    FROM base
  ),
  last20 AS (
    SELECT cid,
      count(*)                                            AS decided,
      count(*) FILTER (WHERE status = 'WIN'  AND rn <= 20) AS w,
      count(*) FILTER (WHERE status = 'LOSS' AND rn <= 20) AS l,
      count(*) FILTER (WHERE status = 'PUSH' AND rn <= 20) AS p
    FROM r GROUP BY cid
  )
SELECT jsonb_build_object(
  'cards',    COALESCE((SELECT jsonb_agg(to_jsonb(cards))  FROM cards),  '[]'),
  'catrec',   COALESCE((SELECT jsonb_agg(to_jsonb(catrec)) FROM catrec), '[]'),
  'streaks',  COALESCE((SELECT jsonb_agg(to_jsonb(streaks)) FROM streaks), '[]'),
  'last20',   COALESCE((SELECT jsonb_agg(to_jsonb(last20)) FROM last20), '[]'),
  'unstamped', (SELECT count(*) FROM base WHERE cv < $currentVersion)
) AS out;
```

JS then applies, using the **existing** shared functions, so there is one
implementation of each rule:

- card present iff `o_w + o_l + o_p > 0`; `overall = {wins, losses, pushes,
  winPct: winPctOf(w, l), count: w+l+p}`; `league` likewise from `l_*`;
  `label = PICK_CATEGORY_LABELS[cat]` (not needed by consumers, kept for shape);
  otherwise `null`. A requested category outside `ALL_CATEGORY_KEYS` gets
  `null` without being sent to SQL (matches JS's `order` filter).
- streak: no row → `{ type: "NONE", count: 0 }`.
- last20: `decided < LEAGUE_RECORD_LAST_N` (or no row) → `null`; else
  `{wins, losses, pushes, winPct: winPctOf(w, l), count: w+l+p}`.
- `unstamped > 0` → `console.error` tripwire (§3.2 G4). No fallback.

Details worth stating:

- `b.sport = r.sport` is the SQL twin of JS's `p.sport.name === leagueSportName`
  (exact, case-sensitive; both sides bytewise under a deterministic collation).
- `LEFT JOIN … GROUP BY` returns a row (zeros) for a requested pair with no
  decided picks, so absence and zero are handled uniformly in JS
  (`overall count == 0` → `null`), same as `computeCategoryBreakdown`'s
  `count > 0` filter.
- Only **requested** pairs are aggregated. Today's code computes a card for
  *every* category a capper has and then reads only the requested keys
  (`records[...]` is built only from `pairs`). The SQL computes only what is
  read.
- `MATERIALIZED` forces one scan of the (userId, capperIds) slice. The planner
  should be checked with `EXPLAIN (ANALYZE, BUFFERS)` on the restored snapshot
  (§8) — this is the one thing in this design I would not sign off on paper.
- Bind-parameter volume: `entries` per call are ≤ the picks on a card / slate
  (tens); Auto-Generate is the largest (a full slate, low hundreds). Well under
  Postgres' 32,767-parameter ceiling, but the implementation PR should
  dedupe `req` / `creq` rows (`DISTINCT`) — the current code already dedupes by
  capper+league.

### 4.3 Reuse vs new (vs #123's `capper-list-aggregates.ts`)

| Piece | Verdict |
|---|---|
| `ORDER`, `ORDER_DESC` constants | **Reuse** (export them). The exact tie-break already agreed in #123. |
| `queryCurrentStreaks` gaps-and-islands | **Reuse the SQL shape**; the function itself cannot be called as-is: its scope type is `Omit<WindowScope, "pooled" \| "capperIds">`, so it always scans every capper of the user, and it runs as its own statement (extra round trip). Either export the streak CTE as a `Prisma.Sql` fragment (preferred: it composes into §4.2's single statement) or add a `capperIds` scope. With `windows: ["ALL"]` its predicate is `wstart IS NULL` ⇒ no `gradedAt` gate, identical to `currentStreak`. |
| `recordStatsFromTotals`, `winPctOf`, `LEAGUE_RECORD_LAST_N` | **Reuse** (`winPctOf` is exported; no new rounding rules — none of these shapes round). |
| `scopePredicates`, `windowsValues`, `IN_WINDOW`, `WIN_UNITS`, `zeroOddsWinUnitsWon`, `queryWindowTotals` | **Not needed** (window and money logic). |
| `KEY` (`createdAt+id` sortable key) | **Not needed** (only used for min-by-key tie-breaks; here ordering is done with `ORDER` inside `row_number`). |
| Category `GROUP BY` on the stored column | **Same technique** as `querySpecialistCandidates` / `queryCategoryPanel`, different grain (requested pairs, not every category) — **new query**. |
| League-column (`b.sport = r.sport` filter) and last-20 | **New.** |

Nothing in `pick-category-sql.ts` (the step-2 doc's CASE fragment) is used or
needed: the stored column replaced it in #123.

## 5. Round trips per consumer call

"RT" = DB round trips (not statements). Baseline assumes §1.1 (2 RT per
`fetchPicksByCapper`); if §1.1 turns out false, baselines halve and the
*relative* win below shrinks but the payload win (§9) is unchanged.

| Consumer call | Today (RT) | New, separate calls | New, combined (§4.2 + §6) |
|---|---|---|---|
| `getLeagueRecordsAction` (Grid Live, expander, pool effect, build) — per call | 2 | 1 | 1 |
| Grid Live game switch (3 section calls, all non-empty) | 6 | 3 | 1 if the panel makes one call (Q4) |
| Sharp Money (`getCapperCategoryRecords`) | 2 | 1 | 1 |
| Auto-Generate (`Promise.all` of both) | 4 (serialized by `connection_limit=1`) | 2 | **1** |
| Hedge / Contrarian (pool, 3 sequential) | 6 | 3 | **2** |

**Latency vs. the current fetch.** `connection_limit=1` (production
`DATABASE_URL` is `pgbouncer=true&connection_limit=1`, per
`docs/c4-grading-throughput.md`) serializes every statement an instance issues,
including the two halves of one `include`. So today's cost per call is
2 × (round trip + transfer + Prisma hydration of ~326 B/row) plus JS
compute over the full history; the new cost is 1 × (round trip + aggregation
over the same rows inside Postgres + ~KB transfer). The database still touches
the same rows via the same index, so its CPU is comparable; what disappears is
one round trip, tens–hundreds of KB of transfer and Prisma object
materialization, and O(history) `pickCategory` work in the app server. **[ESTIMATE]**:
net latency per call is lower or equal in every case I can construct, with the
biggest wins on large slates (Auto-Generate). It is **not** guaranteed for a
tiny call (one capper, ~40 picks) where the extra CTE/window-function work is
comparable to the round trip it saves; §8 measures this with `EXPLAIN ANALYZE`
and wall time on the snapshot rather than asserting it. One long statement also
holds the single connection for its full duration instead of releasing it
between two short ones; for a call that already dominates the request, that is
a wash, but it is why §4.2 must be a single scan (`MATERIALIZED`) and not
four independent scans of `picks`.

## 6. Hedge / Contrarian: can the 3 sequential calls collapse?

Read `parlay-pool-generator.ts:55-135` (Verified). The three calls and their
inputs:

1. **Line 64** `getCapperLeagueRecords(poolPicks…)` — capper set **P** = the
   pool's cappers. Its result feeds `buildPoolPrimary(poolPicks, records,
   requested)` (`:72`), which decides the primary legs.
2. **Line 113** `getCapperCategoryRecords(allPicks with category…)` — capper
   set **A** = cappers of every unstarted pending pick in the *leagues present
   in the primary* (`leaguesInPrimary` → `getLiveBoardData` loop, `:78-108`).
3. **Line 126** `getCapperLeagueRecords([...poolPicks, ...allPicks])` — capper
   set **P ∪ A** (for rendering).

**Answer: 3 → 2, not 3 → 1.**

- Call 1 **cannot** be merged forward: `A` is only known after
  `buildPoolPrimary` (which needs call 1's result) picks the primary legs and
  the `getLiveBoardData` loop runs. There is a true data dependency
  (1 → primary → leagues → games → A).
- Calls 2 and 3 are **independent of each other** and both depend only on
  `allPicks` / `poolPicks` after the games loop. They can be one combined call
  (`getCapperRecordBundle({ leagueEntries: [...poolPicks, ...allPicks],
  categoryPairs })`, one §4.2 statement returning both shapes). Note P ⊆ P ∪ A,
  and the category pairs' cappers ⊆ A ⊆ P ∪ A, so the combined `ids` set is just
  **P ∪ A** and nothing is scanned that isn't already needed for call 3 today.
- Reusing call 1's output for call 3's pool cappers is **not** safe as
  specified: call 1's `records` only contains keys for the *pool's own*
  `(capper, league, category)` entries; a pool capper also appearing in `allPicks`
  with a different league/category needs a key call 1 never computed. Keep it
  as "call 3 fetches P ∪ A afresh" (one statement).

Side finding (not part of this change): `autoGenerateParlayAction`
(`parlay-generator.ts:64-75`) already runs the two callers in `Promise.all`
over the *same* `allPicks`; with `connection_limit=1` they serialize anyway.
The combined bundle makes that one statement.

The same duplication exists on the client: `parlay-pool-section.tsx` fetches
`getLeagueRecordsAction` for the pool on every `poolKey` change (`:259`), again
in `buildMyPicks` (`:294`), and the swap builds re-fetch it as their call 1.
All identical `(userId, capperIds)` — relevant to §7.

## 7. Caching

I do **not** assume caching helps. Reasoning per surface — key = `(userId,
sorted capperIds)` (an entries hash would be finer and make hits rarer).
All hit-rate statements are **[ESTIMATE]** — reasoned from the interaction
patterns in the code; there is no measured repeat-key data.

| Surface | Distinct keys per user per day | Repeat pattern | Expected hit rate |
|---|---|---|---|
| Grid Live | ≈ 3 × (games visited): away / home / other are **three different capper sets** per game (the "other" set is mostly totals/NRFI/prop cappers, often overlapping the others but not equal) | a hit needs the user to return to the same game within the TTL | Low–moderate; only on back-and-forth navigation |
| Standard expander | 1 per game expanded; component keeps its own `data` after first expand | already de-duplicated client-side (`data !== null` guard) | ~0 additional |
| Parlay Pool (cards effect / My Picks build) | one per distinct pool membership; every add/remove produces a new capper set | the *same* set is requested by the effect, `buildMyPicks`, and both Hedge/Contrarian call-1s for one pool composition | **Moderate within one composition (≥ 3 identical requests per build sequence), ~0 across compositions** |
| Auto-Generate | ≈ 1 per (leagues selected, slate state) per day | changing `legCount` or re-clicking reuses the same slate ⇒ same capper set | Moderate–high, but a low-frequency, user-initiated click |
| Hedge/Contrarian (pool) call 2/3 | ≈ 1 per (pool, slate) | two clicks (Hedge then Contrarian) share `allPicks` ⇒ the same P ∪ A | Moderate |

Cost side: after this migration each call is ~1 RT and ~1–10 KB (§9), so the
absolute saving from a hit is small. Costs of caching: (a) **staleness** — a
graded pick changes a streak/record; the contract in
`docs/cache-invalidation-contract.md` has a known hole (P9: opportunistic
page-load grading cannot `revalidateTag`, so only the 60 s TTL bounds it);
(b) `cachedByTag` (`cached.ts`) uses **one string as both key and tag**, so
"reusing the existing tag" means either adding a new `cacheKeys.pickRecords(userId)`
and calling it from `revalidatePickStats` (every mutation path in the contract
already funnels through it), or extending `cachedByTag` to take separate key
and tag arguments — neither is free; the contract doc explicitly says a second
cached surface should get its own tag; (c) per-`capperIds` keys are high
cardinality, so `unstable_cache` entries would mostly be single-use.

**Recommendation: no caching in the first two PRs.** Revisit only if, after the
migration, the pool-composition duplicate calls show up as material in logs. If
a cache is ever added, the only justified target is the Parlay Pool duplicate
(one pool composition → ≥ 3 identical requests), keyed
`(userId, sorted capperIds, entriesHash)`, tag = a new
`cacheKeys.pickRecords(userId)` invalidated from `revalidatePickStats`, TTL 60 s
to match the dashboard's backstop. A cheaper first step that captures most of
that duplicate without any staleness risk is **client-side**: have
`buildMyPicks` reuse the `records` its own effect already fetched for the same
`poolKey` instead of calling the action again (separate client PR, Q5).

## 8. Parity test plan (T2 harness)

Follows the `t3 → t5` rollout convention from step 2: **build → harness diff →
cutover → observation → remove old**.

**Setup requirements found while reading the harness**

- `scripts/t2-harness/fixtures.ts:181` creates picks with **no stamp**
  (`categoryVersion = 0`), and `run-diff.mjs` never runs the backfill; the
  checked-in snapshot `.snapshots/prod_2026_09_15.dump` also predates the
  `category` column. The run must therefore execute
  `backfill-pick-category --apply` against the **disposable** DB after restore
  and before capture, or the SQL path will see `NULL` categories everywhere.
  Consequence to state plainly: on the snapshot the stamps are *produced by
  the same function the JS path calls*, so the snapshot diff proves
  **SQL ≡ JS given correct stamps**; it says nothing about whether production's
  stamps are correct — that is G1's `--verify`, run separately.
- `CappersImpl` in `capture-output.ts` is `/cappers`-shaped. Add a separate
  capture entry point (e.g. `capture-picks-by-capper.ts`) with its own
  registry: `legacy` (a frozen copy of today's JS path, kept as
  `picks-by-capper-legacy.ts` for the rollout, mirroring the adapter's legacy
  functions) vs `sql`.

**Scenarios** (per snapshot user, all cappers):

1. Each capper alone, over every `(sport the capper has picks in) × (every
   category present)` plus one `category: null` entry (`getCapperLeagueRecords`).
2. All of the user's cappers in one call (catches cross-capper contamination in
   the `IN` / `GROUP BY`).
3. `getCapperCategoryRecords` for every `(capper, category)` including pairs
   with **no** picks and pairs with **only** `PENDING` / `CANCELLED`.
4. Replayed slates: for each of the last N game dates, the entries a board for
   that date would send (each pick's own stored category / league).
5. Empty inputs (`entries: []`, `capperIds` with a capper who has zero picks).

**Comparison rules**

- **Exact equality everywhere**, no rounding tolerance: every value is an
  integer count or `winPctOf` of integer counts computed by the same shared
  function (unlike step 2, there are no money fields).
- **Order-independent fields** (`records`, `CategoryBreakdownItem`): **zero
  diffs allowed.** Any diff is a bug. This includes a card present vs `null`.
- **Order-dependent fields** (`streaks`, `last20`): two comparisons.
  1. `legacy` (as-is, unordered fetch) vs `sql`: diffs are *permitted only* where
     the capper has ≥ 2 decided picks sharing the `gameTime` that straddles the
     relevant boundary (the streak's edge / the 20th–21st pick) **and** those
     tied picks differ in a way that changes the answer (different status, or
     — for last-20 — a different status mix). Each such diff is inspected: the
     harness prints the tied rows (`id, status, gameTime, createdAt`) and I
     review them before accepting; the count of accepted diffs is reported.
  2. `legacy-with-explicit-total-order` (the legacy function fed rows sorted by
     `gameTime, createdAt, id` — a one-line reference, no production change)
     vs `sql`: **zero diffs, no exceptions.** This is the hard gate; #1 only
     characterizes the behavior change.
- Any diff not explained by an inspected same-`gameTime` tie is a bug.

**Synthetic acceptance tests** (disposable DB, same style as
`capper-list-aggregates-acceptance-test.ts`): status handling (a category
whose picks are all `PENDING` → `null`; `CANCELLED` ignored; `PUSH` counted in
`count` and last-20 but skipped by, and not breaking, a streak); last-20 with
19, 20, and 21 decided picks (`null` / present / cut), with and without a
`gameTime` tie at the cutoff; streak tie at the edge; `NULL`-category rows
still count toward streak and last-20; sport-name case sensitivity for the
league column; a capper with zero picks (`NONE`, `null`); unstamped rows
trigger the tripwire and are absent from cards; a requested category outside
`ALL_CATEGORY_KEYS` → `null`; a category with ≥ 100 decided picks (only if `recent`
is retained, Q3).

**Performance checks** (local snapshot, not production): `EXPLAIN (ANALYZE,
BUFFERS)` for the Auto-Generate-sized call (≈ 40 cappers) and a Grid Live-sized
call (≈ 8), confirm one scan of `picks` and the index used; wall time of legacy
vs SQL through the real `prisma` client with `log: ["query"]` enabled — this
also resolves §1.1's "2 statements" assumption.

## 9. Estimated payload, before and after

**All numbers are [ESTIMATE].** Inputs, from the step-2 doc's measurements on
the anonymized snapshot: heaviest account 4,291 picks over 110 cappers
(mean ≈ 39 picks/capper), `pg_column_size` averages 274.5 B/row raw and 325.7
B/row joined to `sports`. The raw column size is a lower bound on wire bytes
(step 2 makes the same caveat). Cappers on a live board are the *active* ones,
so their histories skew above the mean; I show the mean and a 3× tail.

| Call | Cappers | Before (rows → bytes) | After |
|---|---|---|---|
| Grid Live, one section | ~5 | 5 × 39 ≈ 195 rows ≈ **64 KB** (3× tail ≈ 190 KB) | ~1 KB |
| Grid Live game switch (3 sections) | ~12 total | ≈ 470 rows ≈ **150 KB** (tail ≈ 460 KB) | ~2–3 KB (3 calls) or ~2 KB (1) |
| Auto-Generate (league records + category records) | ~40 | 2 × 1,560 rows ≈ **1.0 MB** (tail ≈ 3 MB) | ~6–10 KB (one bundle) |
| Hedge/Contrarian (pool), 3 calls | 8 + 40 + 45 | ≈ 3,600 rows ≈ **1.2 MB** per click (tail ≈ 3.5 MB) | ~8–12 KB (2 calls) |
| Sharp Money | ~15 | ≈ 585 rows ≈ **190 KB** | ~1–2 KB |

"After" model: one JSON object per requested `(capper, league, category)` or
`(capper, category)` (~110 B each), plus one streak row and one last-20 row per
capper (~50 B each). Auto-Generate: ~40 pairs × (cards ≈ 110 B + catrec ≈ 70 B)
+ 40 × 100 B ≈ 11 KB upper bound. Reduction ≈ **98–99.5%** per call. App-server
CPU also drops: today each call runs `pickCategory` over the full history twice
per (capper, league) (`computeLeagueRecordCards` calls `computeCategoryBreakdown`
on the full and the league-filtered history) plus `computeStats` and the
last-20 sort; the new path does none of that in JS.

## 10. Proposed PR split and open questions

**PR split** (each shippable alone, in order):

1. **Docs** — this document.
2. **Verification groundwork** (no behavior change): `--verify` mode on
   `backfill-pick-category`; the exhaustive `pickCategory` matrix test (G2);
   the `ALL_CATEGORY_KEYS` completeness test (G3); harness support (stamp step,
   `capture-picks-by-capper.ts`, `legacy` copy). Gate: user runs `--verify`
   against production and reports zero mismatches.
3. **SQL implementation behind the existing function signatures**:
   `getCapperCategoryRecords`, `getCapperLeagueRecords` (+ the bundle
   function), export of `ORDER` / the streak fragment, tripwire, synthetic
   acceptance tests, T2 parity run attached to the PR. **Ships as a PR for
   manual review, not auto-merged** — it feeds the parlay ranking
   (Auto-Generate / Hedge / Contrarian) and Sharp Money's qualification gate,
   i.e. model-feeding logic.
4. **Call-site collapse**: `parlay-pool-generator.ts` 3 → 2 and
   `parlay-generator.ts` 2 → 1 using the bundle; separately, optional client
   PRs for the Grid Live single-call panel and `buildMyPicks` record reuse
   (Q4, Q5).
5. **Removal**: delete `fetchPicksByCapper` and the `legacy` copy after an
   observation period, same convention as step 2.

**Open questions**

- **Q1 — Tie-break behavior change (§4.1).** Approve `gameTime, createdAt, id`
  for both the streak and the last-20 cutoff, knowing the last-20 cut may
  select different tied picks than today's typical (heap-order) result, and
  that same-`gameTime` ties are common? Alternative: preserve today's *typical*
  last-20 behavior with `gameTime DESC, createdAt ASC, id ASC` at the cost of
  two inconsistent definitions of "most recent".
- **Q2 — Tripwire for unstamped rows (G4).** OK to add the zero-round-trip,
  detection-only `categoryVersion < current` count and `console.error`, given
  #125 intentionally removed the fallback? Or do you want a hard failure /
  nothing?
- **Q3 — Drop `item.recent`?** No consumer reads it (§2.2). Dropping it removes
  a per-category `row_number` partition and the ≥ 100-decided gate. Confirm no
  out-of-tree reader (e.g. a planned surface) before removal.
- **Q4 — Grid Live: one panel-level call instead of three?** It saves 2 of the
  3 round trips and 2 server-action invocations per game switch, but it
  reverses the deliberate "each team section fetches independently so one
  team's picks aren't blocked on the other's records" design
  (`team-picks-panel.tsx` header comment). I have **not** verified how Next
  schedules concurrent server actions from one client (I believe they are
  queued one at a time; **[UNVERIFIED]**) — that determines whether the 3
  calls are effectively serial today.
- **Q5 — Client-side dedupe in the Parlay Pool** (`buildMyPicks` reuse of the
  effect's `records`): in scope for this effort or a separate change?
- **Q6 — Output shape for the bundle.** A single `getCapperRecordBundle`
  returning `{ leagueRecords, categoryRecords }`, with the two existing
  exported functions kept as thin wrappers (so `sharp-money.ts` and the actions
  don't change signatures), is my proposal. Agreed?
- **Q7 — Index.** The statement filters `(userId, capperId)` then `status`.
  Existing indexes: `(userId, capperId)`, `(userId, status)`. I don't expect a
  new index to be needed at current volume; confirm with `EXPLAIN` in PR 2
  rather than adding one now.
- **Q8 — Doc location.** Written to `docs/picks-by-capper-egress.md` as
  requested; the step-2 reference lives at `docs/design/cappers-egress-step2.md`.
  Move under `docs/design/` if you want them together.
