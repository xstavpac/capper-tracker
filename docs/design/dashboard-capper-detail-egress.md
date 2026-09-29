# `/dashboard` and `/cappers/[capperId]` egress reduction — design

Status: **design only** — no implementation code, no migrations, no schema
changes, no production access, and the local `capper_flaky` DB was not touched.
Same shape as `docs/design/picks-by-capper-egress.md` (#130) and
`docs/design/cappers-egress-step2.md` (#123/#125); this doc reuses their
machinery wherever it can.

Epistemic tags: **Verified** (read in the repo at `1659b23`), **[ESTIMATE]**
(modeled from numbers in the two earlier docs, not measured), **[UNVERIFIED]**
(believed true, with the check that would settle it).

## Decided inputs (not re-litigated here)

- Every section keeps **full-history semantics**. Displayed numbers must not
  change; the fix is computing in the database, not bounding the history.
  "Recent picks" is naturally bounded (take N of the ordered rows).
- Ordering / tie-break: `gameTime, createdAt, id` (as `ORDER` / `ORDER_DESC` in
  `capper-list-aggregates.ts:93-94`). The in-progress PR that adds this
  tie-break to the JS sorts in `stats.ts` is **assumed merged**; the JS side and
  the SQL side therefore share one total order.
- The stored `Pick.category` column alone; never runtime `pickCategory()`.

## 1. Why: what runs today

### 1.1 `/dashboard`

`getDashboardSummary(userId)` (`stats.ts:1512`) is `cachedByTag`
(`dashboard:${userId}`, 60 s). On a miss `computeDashboardSummary` calls
`getPickRowsForStats` (`stats.ts:1491`): `pick.findMany({ where: { userId },
orderBy gameTime desc, include: { sport:{name}, capper:{id,name}, league:{id,name} } })`
— **every scalar column of every pick the user ever made**. From that one array
it derives (Verified, `stats.ts:1519-1550`):

| Output | Derivation | Read by the page |
|---|---|---|
| `overall` | `computeStats(picks)` | `wins, losses, pushes, roi, netUnits` only. `currentStreak`, `longestWinStreak`, `longestLossStreak`, `winPct`, `unitsWon`, `unitsLost` are computed and **never rendered** (grep of `src/app`, `src/components`: no `summary.overall.*` read of them). |
| `totalPicks` | `picks.length` (**all** statuses) | hero tile |
| `categoryBreakdown` | `computeCategoryBreakdown(picks, DEFAULT_CHIP_SET)` (runtime `pickCategory`) | "Record by category" tiles; counts + `winPct`, no money |
| `chartData` | `downsampleUnitsChart(computeUnitsChartData(picks))` | Performance chart |
| `pendingCount`, `stalePendingCount` | filters on `PENDING` (stale: `gameTime < now − 24 h`) | hero tile, banner |
| `recentPicks` | `picks.slice(0, 10)` of the `gameTime desc` fetch, flattened | Recent picks list |

Round trips **[UNVERIFIED — `log: ["query"]` in the harness settles it]**:
`@prisma/client ^5.20.0`, no `relationJoins` preview feature, so each `include`
is its own `WHERE id IN (…)` statement: **1 + 3 = 4 statements** per cold
summary. The page also runs `getCapperPanels` (cached, same tag) and
`getPlanStatus` (2 statements, uncached).

**Adjacent finding, out of this doc's scope but it changes what the dashboard
PR can claim:** `getCapperPanels` → `computeCapperPanels`
(`capper-panels.ts:142`) also reads **full pick history** (`pick.findMany({ where
})`, all columns, all the user's cappers) on every cold miss. Migrating
`getDashboardSummary` alone does not stop `/dashboard` from reading full
history; see Q1.

### 1.2 `/cappers/[capperId]`

Uncached, and under the `(app)` layout's `force-dynamic`. Every load — including
every `?window=` / `?categoryWindow=` / `?categorySport=` `<Link>` click, which
re-renders the server component — runs (Verified, `page.tsx:88-108`):

1. `requireUser` (1 statement — `getClaims` is local; the Prisma `user` find is
   the statement),
2. `getCapperById` (1),
3. `getPicksForCapper` (`picks.ts:207`): `findMany({ include: { capper: true,
   sport: true, league: true } })` — every column of every pick of this capper
   plus three relation statements = **4** statements, ~550 B/row (per the
   investigation; step-2 measured 325.7 B/row for a pick joined to `sports`),
4. `getCappersWithPickCounts` (1): full `capper` rows for every capper the user
   has plus `_count`, mapped down to `{ id, name, pickCount }`.

Total **≈ 7 statements** per load **[UNVERIFIED, same query-log check]**. From
the one `picks` array the page derives, in JS, everything below. Note
**`window`, `categoryWindow` and `categorySport` are three independent params**
(`page.tsx:57-70, 78`); the brief's cache key `(userId, capperId, window,
categorySport)` is missing `categoryWindow` (see §5).

| Section | Derivation | Scope |
|---|---|---|
| Hero stat cards (Record / ROI / Net units) | `computeStats(filterPicksByGameWindow(picks, window))` | `window`, all sports |
| Current streak card / badge | `computeStats(picks).currentStreak` | all-time, deliberately unwindowed |
| Momentum panel | `computeMomentum(picks)` — **O(n²)** (`currentStreak()` over every prefix) | all-time |
| "Record by bet type (all sports)" | `computeCategoryBreakdown(picks, DEFAULT_CHIP_SET)` (all-time; gates whether the section renders) and the same over the `window`-filtered picks (what it shows) | all sports |
| "Units over time" chart | `computeUnitsChartData(filterPicksByGameWindow(picks, window))` — full fidelity, **no downsampling** | `window`, all sports |
| Sport tabs | per distinct sport: `computeCategoryBreakdown(sportPicks, chipSetForLeague(sport))` all-time; keep those with ≥ 1 tile; **sort by total tile count desc** (stable → ties keep first-appearance order in `picks`); default = first | all-time |
| Sport section (record strip, tiles, chart) | selected sport's picks, `categoryWindow`-filtered: `computeStats` (only if the windowed set is non-empty — any status), `computeCategoryBreakdown(…, chipSetForLeague(sport))`, `computeUnitsChartData` | `categoryWindow` × selected sport |
| Recent picks (10) | `selectCapperRecentPicks(picks, selectedCategorySport)` → newest 10 of that sport (all statuses), all sports if the capper has no tab | selected sport |
| Tracked since / Last pick | `min` / `max` of `datePosted` over **all** picks | all-time |
| Best odds range | `computeBestOddsRange(picks)` | all-time |
| Consistency | `computeConsistency(picks)` — the page shows the **label only**; `cv` is never rendered | all-time |
| Edit panel `associatedPickCount` | `picks.length` (all statuses) | all-time |

`getPicksForCapper` has a second full-history caller,
`capper-comparison.ts:118` (Verified by grep) — **out of scope**; it means the
function cannot be deleted by the capper-detail PR, only un-called from this
page.

## 2. Status handling and the windowed predicate (shared facts)

`PickStatus` = `PENDING | WIN | LOSS | PUSH | CANCELLED` (no `VOID`).

- Record / tiles / streak / momentum / odds range / consistency / chart read
  **decided** rows only (`WIN`/`LOSS`/`PUSH`; streak and momentum `WIN`/`LOSS`).
- `totalPicks`, `associatedPickCount`, "tracked since/last pick", recent picks,
  and the "is the windowed set non-empty" gate for the sport strip count **all
  statuses** (a windowed `CANCELLED` pick with `gradedAt` set counts — the
  `nPicks` semantics `queryWindowTotals` already reproduces).
- Window predicate, from `filterPicksByGameWindow` / `scorecardWindowRange`:
  `ALL` = no predicate at all; every other window =
  `gradedAt IS NOT NULL AND gameTime >= wstart AND gameTime < wend`, bounds
  bound as parameters from **one** `now` (already `IN_WINDOW` + `windowsValues`
  in `capper-list-aggregates.ts`).

## 3. Shared building blocks

### 3.0 Shape: SQL fragments composed per page, not exported functions

`queryWindowTotals` and friends each execute their own statement. Under
`connection_limit=1` (production `DATABASE_URL` has `pgbouncer=true&connection_limit=1`)
statements serialize, so calling five existing-style functions per page would
just re-create today's round-trip count. #130 solved this with one statement
that returns one `jsonb` (`queryCapperRecordBundle`). Same here: each building
block below is an exported **`Prisma.Sql` fragment builder + a row mapper**;
each page composes the fragments it needs as CTEs of **one** statement.
`queryWindowTotals` becomes a thin wrapper over its own fragment (pure refactor
of #123 code; its acceptance test — `capper-list-aggregates-acceptance-test.ts` —
is the guard). Every fragment returns **raw totals only**; `winPct`, ROI,
`round2`, label, the sort and the best-range choice stay in `stats.ts`, applied
by finalizer functions that the legacy JS path also calls (one implementation
of each rule, the rule #123 set).

Common inputs of every fragment: `userId` (always), optional `capperId`
(capper page), a window list from `scorecardWindowRange` with one `now`,
optional sport, and the ordering constants `ORDER` / `ORDER_DESC`.

### 3.a Window totals / record / ROI / units — **reuse**

`queryWindowTotals` already returns, per `(capper|pooled) × window`: `nPicks`
(all statuses), `wins`, `losses`, `pushes`, `unitsWon`, `unitsLost`,
`unitsRisked`, `zeroOddsWinFlags`, with float sums as
`sum(x ORDER BY ORDER) FILTER (…)` (sequential, tie-broken — the JS accumulation
order) and `WIN_UNITS` spelled in `float8` (`units * (odds/100)` /
`units * (100/abs(odds))`, IEEE-identical to `unitsWonOnBet`).

| | Dashboard | Capper detail |
|---|---|---|
| Scope | `{ userId }`, `pooled: true`, `windows: ["ALL"]` | `{ userId, capperIds: [id] }`, `windows: [window]` (hero) |
| Output → JS | `recordStatsFromTotals(totals)` → `overall`; `nPicks` = `totalPicks` (ALL has no predicate, all statuses — identical to `picks.length`) | `recordStatsFromTotals` → hero `stats` |

Two additions, both additive and defaulting to today's behavior:

1. A **`groupBySport`** option (adds `s.name` to the `GROUP BY`; needs
   `JOIN sports`). The capper page needs money totals for `categoryWindow` per
   sport because the selected sport is not known until the all-time tab list is
   computed (§3.b, Q3 explains why that stays one statement). `nPicks > 0` per
   sport reproduces `activeSportPicksInWindow.length > 0`.
2. Zero-odds flag handling stays exactly as `pick-aggregates-cappers-adapter.ts`
   does it (`zeroOddsWinUnitsWon(flags)` → the JS `Infinity`/`NaN`).

Output shape: `WindowTotals` (existing), plus `sport: string | null`.

### 3.b Category tiles

One fragment, one grouped scan:

```sql
-- $windows = the (win, wstart, wend) VALUES table; capper scope optional; sport grouping optional
SELECT w.win, [s.name AS sport,] p.category,
       count(*) FILTER (WHERE p.status = 'WIN')  AS w,
       count(*) FILTER (WHERE p.status = 'LOSS') AS l,
       count(*) FILTER (WHERE p.status = 'PUSH') AS pu
FROM picks p
JOIN w ON <IN_WINDOW>
[JOIN sports s ON s.id = p."sportId"]
WHERE p."userId" = $userId [AND p."capperId" = $capperId]
  AND p.status IN ('WIN','LOSS','PUSH')
  AND p.category IS NOT NULL                       -- JS: if (!key) continue
  [AND p.category = ANY($chipSet::text[])]         -- dashboard only (pushdown)
GROUP BY w.win, [s.name,] p.category
```

- **Dashboard:** `windows: ["ALL"]`, no sport grouping, chip set pushed down
  (`DEFAULT_CHIP_SET` is passed in from the JS constant, so the six keys live in
  one place) → ≤ 6 rows.
- **Capper detail:** `windows: [ALL, window, categoryWindow]` (deduped),
  grouped by sport → one row per `(window, sport, category)` the capper has.
  No chip-set pushdown: chip sets vary per sport, and sending all categories
  (≤ ~15 per sport [ESTIMATE]) keeps `chipSetForLeague` in JS. JS then derives
  *all three* tile families from this one result:
  - "Record by bet type (all sports)" all-time (the render gate) = rows
    `win = ALL`, summed over sports, filtered to `DEFAULT_CHIP_SET`;
  - the `window` version = rows `win = window`, same reduction;
  - sport tabs = rows `win = ALL` per sport filtered to `chipSetForLeague(sport)`,
    `count > 0`, sorted by total tile count desc;
  - selected sport's tiles = rows `win = categoryWindow`, that sport, its chip set.
- **First-appearance tie-break for the tab sort.** `Array.from(new Set(picks.map(p => p.sport.name)))`
  is in first-appearance order over **all statuses**, gameTime ascending, and
  the sort is stable, so two sports with equal tile totals keep that order. The
  fragment therefore also returns, per sport, `firstKey` = the minimum sortable
  `(gameTime, createdAt, id)` key over **all** the capper's picks (same
  fixed-width-digits + `COLLATE "C"` construction as `KEY` in
  `capper-list-aggregates.ts:170`, with `gameTime` prepended). JS sorts ties by
  it. Missing this silently reorders tabs when two sports tie.

A shared JS finalizer, **`categoryBreakdownFromCounts(rows, order)`**, does the
mapping (`label = PICK_CATEGORY_LABELS[key]`, `winPct = winPctOf(w, l)`,
`count = w+l+pu`, `order` filter, `count > 0` filter); `computeCategoryBreakdown`'s
own tail is refactored to call it, so legacy and SQL share the mapping. **Tiles
have no money field**, so no float concerns here. G1–G4 of #130 §3.2 (the
`--verify` stored-vs-recomputed check, the exhaustive `pickCategory` matrix, the
`ALL_CATEGORY_KEYS` completeness test, the static no-unstamped-creator guard)
are the same prerequisites; if PR 2 of #130 has landed they are already met, if
not they gate this work too.

### 3.c Units chart series

**Can the DB return the dashboard series already downsampled, matching
`downsampleUnitsChart` exactly? Yes, by construction — with two preconditions
and a fallback.**

`downsampleUnitsChart` (`units-chart-downsample.ts`) is pure integer/IEEE
arithmetic over an ordered array: for `n ≤ 2000` it is the identity; otherwise
first point, then for each of 999 buckets `[1 + ⌊b·bs⌋, 1 + ⌊(b+1)·bs⌋)` with
`bs = (n−2)/999` the lowest and highest `cumulativeUnits` (first index wins
ties; deduped; emitted ascending), then the last point. All of that is
expressible in SQL over `row_number()`:

```sql
WITH s AS (                       -- settled rows, chronological
  SELECT p."gameTime" AS gt,
         row_number() OVER (ORDER BY <ORDER>) - 1 AS idx,
         sum(<delta> ) OVER (ORDER BY <ORDER> ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS run
  FROM picks p WHERE p."userId" = $u [AND p."capperId" = $c] [AND <IN_WINDOW>]
    AND p.status IN ('WIN','LOSS','PUSH')
),
c AS (SELECT s.*, <round2_sql>(run) AS cum, count(*) OVER () AS n FROM s),
-- n <= 2000: emit c as-is. Else:
b AS (SELECT g AS b, 1 + floor(g::float8 * bs)::int AS lo, 1 + floor((g+1)::float8 * bs)::int AS hi
      FROM generate_series(0, 998) g, LATERAL (SELECT ((SELECT n FROM c LIMIT 1) - 2)::float8 / 999::float8 AS bs) x),
pick AS (SELECT b.b, min(c.cum) mn, max(c.cum) mx FROM b JOIN c ON c.idx >= b.lo AND c.idx < b.hi GROUP BY b.b)
-- lo-index = min(idx) FILTER (cum = mn); hi-index = min(idx) FILTER (cum = mx)  [first-index tie-break]
SELECT idx, gt, run FROM … ORDER BY idx
```

`<delta>` = `CASE WHEN WIN THEN <WIN_UNITS> WHEN LOSS THEN -p.units ELSE 0::float8 END`
(`x − u ≡ x + (−u)` and `+ 0 ≡ identity` in IEEE, so the running sum is the
JS `running += / -=` sequence bit for bit). The window frame **must** be
`ROWS`, not the default `RANGE` (peers would collapse), which the total order
makes moot but which should not be left to that. `<round2_sql>` must be
**round-half-up**, not Postgres `round(float8)` (which is half-to-even) and not
`round(numeric)` (half away from zero): JS `Math.round(x·100)/100` ties toward
+∞, i.e. `CASE WHEN y − floor(y) >= 0.5 THEN ceil(y) ELSE floor(y) END / 100::float8`
with `y = x * 100::float8`. It is used **only** to decide bucket extrema and
ties; the value emitted is the unrounded `run`, and JS applies the existing
`round2` — so the rounding rule stays defined once in JS and SQL merely has to
agree with it for comparisons.

Preconditions: (1) **odds = 0.** `float8` division by zero *errors* in
Postgres, so the `NULLIF` guard from `WIN_UNITS` is required, and the JS
`Infinity`/`NaN` poison (which then makes every later point non-finite) cannot
be produced by SQL. Both creators reject `odds === 0` (`pick-validation.ts`,
called from `picks.ts:47` and `bulk-picks.ts:631`), and #123 reproduces poison
for totals via `zeroOddsWinFlags`. For the series: the fragment also returns
`bit_or(zero-odds-kind) FILTER (WHERE WIN AND odds=0)` **as a running window
value**, and the JS mapper substitutes `zeroOddsWinUnitsWon(flags)` for `round2(run)`
from the first flagged row on (reproduced, not fixed — consistent with the
adapter). The SQL downsample is defined only on finite series; if the scope-level
flag is non-zero the fragment returns the un-downsampled `(idx, gt, run, flags)`
rows and JS `downsampleUnitsChart` runs on them. That path is unreachable while
`odds = 0` rows number zero; a `CHECK (odds <> 0)` would make that structural
(Q6). (2) **jsonb round-trip of `float8`** must be shortest-round-trip (PG ≥ 12
`extra_float_digits` default) — **[UNVERIFIED]**, settled by `SHOW server_version`
and the 10⁶-random-doubles test in §8.

**If SQL downsampling cannot be made bit-exact** (the §8 parity run on the
heaviest snapshot account and on synthetic 5k/20k series is the judge), the
narrowest raw series is **`(gameTime, run)` per settled pick — two numbers**,
unrounded `run` from the same running-sum expression, JS keeps
`downsampleUnitsChart`. It costs ≈ 26 B/point [ESTIMATE] — negligible under
2,000 points, ≈ 520 KB at 20k. This fallback is what I would ship if any
divergence shows up; it is a strict subset of the SQL path (same CTE, no
bucketing stage).

- **Dashboard:** scope `{userId}`, no window, downsample **on**.
- **Capper detail:** downsample **off** (the page plots full fidelity today —
  keeping it is a "displayed numbers must not change" requirement). Two series
  in the one statement: `window` all-sports (`PARTITION` none) and
  `categoryWindow` **partitioned by sport** (`sum() OVER (PARTITION BY sport …)`,
  every sport, since the selected one is not known yet). Together they are ≤ 2×
  the capper's decided count.
- **Labels:** the fragment returns `gameTime` as epoch ms; the mapper builds
  `date: formatEastern(new Date(t), { month: "short", day: "numeric" })` in JS —
  no `to_char`/ICU locale parity risk, and the same function as today.

Output shape: `Array<{ t: number; run: number; flags?: number }>` →
`UnitsChartPoint[]` (`{ date, cumulativeUnits: round2(run) }`).

### 3.d Recent N picks

Narrow select, **no relations**, `ORDER_DESC`, `LIMIT N`:

| Page | Columns | N |
|---|---|---|
| Dashboard | `p.id, p."awayTeam", p."homeTeam", p."betDetail", p."betType", p.line, p.status, p.units, c.name AS capperName` (`JOIN cappers c`) — exactly what `formatPickLabel` + the row need | 10 |
| Capper detail | `p.id, awayTeam, homeTeam, betDetail, betType, line, odds, units, gameTime, status, [sport]` — what the row + `PickStatusButtons` + `formatPickLabel` read | 10 **per sport** + 10 overall |

`selectCapperRecentPicks` today = the ASC array reversed, scoped to the selected
sport, sliced — i.e. `ORDER_DESC` over **all statuses**. Selection is unknown
until the tab list exists, so the statement returns
`row_number() OVER (PARTITION BY sport ORDER BY <ORDER_DESC>) <= 10` for every
sport plus the overall top 10 (for the no-tab fallback), and JS picks the right
list (`selectCapperRecentPicks` keeps its signature and `scopedSport` echo). A
capper has few sports, so this is ≤ ~3 × 10 rows [ESTIMATE].

### 3.e Pending counts

`count(*) FILTER (WHERE status = 'PENDING')` and
`count(*) FILTER (WHERE status = 'PENDING' AND "gameTime" < $staleCutoff)` where
`staleCutoff = now − 24 h` is bound from the same `now` the JS uses. Dashboard
only; can ride in the totals statement (`(userId, status)` index exists).

## 4. Capper-detail-only sections

All are SQL-able with small outputs; none *requires* an ordered raw series. The
raw fallback is named per section. Ordering: every `row_number()` uses `ORDER`
(`gameTime, createdAt, id COLLATE "C"`) over the capper's picks.

| Section | SQL | Returns | Raw fallback (min columns) |
|---|---|---|---|
| **Tracked since / last pick / pick count** | `min("datePosted")`, `max("datePosted")`, `count(*)` over **all statuses**, as epoch-ms `bigint` via the existing `round(extract(epoch FROM …) * 1000)` construction. `count(*)` = `associatedPickCount` and the `ALL`-window `nPicks`. | 3 numbers | n/a |
| **Current streak** (all-time) | the `queryCurrentStreaks` gaps-and-islands, `windows: ["ALL"]`, `capperIds` scope — exported as a **fragment** (its function takes no `capperIds` and is its own statement, same finding as #130 §4.3) | `{type, count}` or none → `{NONE, 0}` | `(status)` of decided W/L, ordered |
| **Momentum** | gaps-and-islands with the run length *ending at each row*: `d` = W/L rows with `rn`; `g = rn − row_number() OVER (PARTITION BY status ORDER BY rn)`; `run = row_number() OVER (PARTITION BY status, g ORDER BY rn)`; `pst = lag(status)`, `prun = lag(run)`; then `GROUP BY pst, least(prun, 4)` with `count(*) FILTER (status='WIN')`, `FILTER (LOSS)`, `sum(CASE WHEN WIN THEN <WIN_UNITS> ELSE -p.units END ORDER BY rn)`. `PUSH` is excluded up front (JS filters it before the scan — invisible to streaks). The first row has no `pst` and is skipped, as the JS loop starts at `i = 1`. O(n log n), replaces the O(n²) prefix scan. | ≤ 8 rows `(after, len, w, l, net)` → JS `round2(net)`, `winPctOf`, the fixed 4-row shape (`toRows` keeps the "4+" bucket and zero-fill) | `(status, units, odds)` of decided W/L, `ORDER` — 3 columns, ≈ 15 B/row; JS `computeMomentum` unchanged (only its parameter type narrows to `Pick<…, "status"\|"gameTime"\|"units"\|"odds">`) |
| **Best odds range** | `GROUP BY p.odds` over decided rows: `w, l, pu` and `min(rn)` (first-appearance rank among decided). **Grouped by the raw odds value, not by bucket**, so the bucket thresholds are not re-declared in SQL — JS folds values into buckets with the existing `oddsBucket()`. | ≤ ~60 rows (distinct odds values) | `(odds, status)` of decided, `ORDER` — 2 columns |
| **Consistency** | two ordered passes: `n`, `sum_r = sum(r ORDER BY rn)`, `sum_u = sum(units ORDER BY rn)` with `r = CASE WIN → <WIN_UNITS> WHEN LOSS → -units ELSE 0 END`; then `sum_sq = sum((r − sum_r/n) * (r − sum_r/n) ORDER BY rn)`. JS finalizer `consistencyFromTotals({n, sum_u, sum_sq})`: null if `n < 5` or `avgUnits === 0`; `sd = Math.sqrt(sum_sq / n)`; `cv = sd / (sum_u / n)`; label by the **unrounded** `cv >= 1.5`. | 3 numbers | `(status, units, odds)` of decided, `ORDER` — 3 columns; JS `computeConsistency` unchanged |

Notes:

- **Best odds range tie rule.** `computeBestOddsRange` keeps the first bucket
  (Map insertion order = first-appearance in the ordered picks) on an exact
  `(winPct, count)` tie. Hence the `min(rn)` column; the JS finalizer
  `bestOddsRangeFromRows(rows)` sorts the folded buckets by it before running the
  existing comparator. Sample gate is `bucketPicks.length >= 3` over decided rows.
- **Consistency `**2`.** The JS variance term is `(v − mean) ** 2`; the SQL twin
  writes `d * d`. V8's `**` is `Math.pow`, and `pow(x, 2)` is not *guaranteed*
  bit-equal to `x*x`. This is checked directly, not assumed: §8's first
  micro-test compares `d ** 2` to `d * d` over 10⁷ random doubles on the project's
  Node version. If any pair differs, the SQL uses `power(d, 2)` if *that* matches
  (glibc `pow`), else consistency ships on its raw-series fallback. The observable
  effect of a 1-ULP difference is only a label flip when `cv` is within ~10⁻¹⁵ of
  1.5, so the risk is real but tiny; the test removes it.
- **Momentum / consistency / odds-range are new SQL twins of existing JS
  algorithms.** That is the point of this section, and it is also what the
  project's "extend, don't write a parallel calculation" rule cautions against;
  see Q2. The narrow-series fallback is the alternative that keeps the JS
  algorithms as the only implementations.

## 5. Money parity

Money-bearing outputs: dashboard `overall.roi / netUnits`, recent-pick `units`
(pass-through of a `Float`), chart `cumulativeUnits`; capper page `roi / netUnits`
(hero + sport strip), chart, momentum `netUnits`, consistency `cv`, recent-pick
`odds/units`.

| Concern | Position |
|---|---|
| **Per-pick value** | `units * (odds/100)` / `units * (100/abs(odds))` in `float8` via `WIN_UNITS` — the same IEEE double as `unitsWonOnBet`. Never `/ 100.0` (numeric division). Reused verbatim (exported). |
| **Summation order** | JS adds in `gameTime, createdAt, id` order (assuming the tie-break PR). SQL uses `sum(x ORDER BY <ORDER>)` for aggregates and `ROWS UNBOUNDED PRECEDING` running windows — sequential, **not** the planner's arbitrary/parallel partial-aggregate order, which is exactly why #123 uses ordered aggregates. The `FILTER` reproduces JS's per-status accumulators (`unitsWon` over WINs only, `unitsLost` over LOSSes, `unitsRisked` over W/L/P). Momentum's running bucket sum mixes `+ win` and `− stake` in one sequence in both implementations. |
| **Rounding** | All rounding stays in JS `round2` (`recordStatsFromTotals`, `toRows`, the chart mapper) applied to unrounded SQL totals. The single SQL rounding is the half-up expression in §3.c, used only for downsample comparisons. `round(float8)` (half-even) / `round(numeric)` (half away from zero) are both **wrong** for `Math.round`'s ties-toward-+∞ and must not appear. |
| **`-0`** | `sum` of a lone `-units` with `units = 0` or `Math.round(-0.3)` yield `-0`; `+ 0.0` normalizes on the SQL side. Displays are unaffected (`(-0 >= 0 ? "+" : "") + -0` → `"+0"` both sides) but the parity comparator must treat `-0` and `+0` as equal (or normalize), not fail on `Object.is`. |
| **`odds = 0`** | Cannot be created (both creators reject it). If a row exists: `float8` division by zero errors in Postgres, so the `NULLIF` guard stays; totals reproduce JS poison via `zeroOddsWinFlags` + `zeroOddsWinUnitsWon` (existing); the series carries a running flag (§3.c); momentum/consistency use the same scope-level flag — **reproduced, not fixed** — but do note this is the one place I would rather add `CHECK (odds <> 0)` (Q6) than carry three flag paths for an unreachable state. Prod count of `odds = 0` rows must be re-checked when the harness runs (the step-2 snapshot had zero). |
| **`float8` → JS** | `$queryRaw` returns `float8` as a JS number (exact). Through `jsonb` it goes `float8out → numeric → JSON text → JSON.parse`; exact iff Postgres emits the shortest round-trip form (PG ≥ 12). Verified by test, not assumed (§8). |
| **How exact can the parity test be?** | **Bit-exact is the target for every number**, because both sides perform the same IEEE operations in the same order on the same per-pick doubles. Gate: every *displayed* value (everything after `round2`/`winPctOf`, every label, every count, every ordering) is `===`-equal (zero diffs). Reported but **non-gating**: any ULP difference in an *unrounded* intermediate (raw `unitsWon` sums, `sum_sq`, `cv`) that does not change a rounded value or label — each one is printed and reviewed, because it would indicate an ordering or operation mismatch worth understanding. No display-rounding tolerance is applied silently (unlike step 2's 2-decimal tolerance); a diff in a displayed value is a bug. |

## 6. Round trips per page load, before and after

`connection_limit=1` serializes every statement an instance issues. Baselines
assume the Prisma 5 `query` strategy (**[UNVERIFIED]**, settled by the same
`log: ["query"]` run as #130 §1.1). "RT" = statements.

| Page / state | Today | After |
|---|---|---|
| `/dashboard`, summary **cold** | user 1 + summary **4** + panels **2** (`capper` + `pick`, by `getCapperPanels`) + plan **2** = **9** | user 1 + summary **1** + panels 2 + plan 2 = **6** (panels unchanged, Q1) |
| `/dashboard`, summary **warm** (60 s TTL) | user 1 + plan 2 = **3** | unchanged **3** — the win is the cold miss, which recurs after every `revalidateTag` (each grade/mutation for that user) |
| `/cappers/[id]`, every load | user 1 + capper 1 + picks **4** + capper list 1 = **7** | user 1 + capper 1 + **bundle 1** + capper list 1 = **4** |
| `/cappers/[id]`, capper list deferred (below) | — | **3** |

- **One statement for the capper page** (rather than "tabs first, then selected
  sport") is deliberate. The dependency (selected sport ← all-time tab list) is
  resolved in JS by returning the selection-dependent pieces — per-sport totals,
  per-sport `categoryWindow` series, per-sport recent 10 — for **every** sport
  the capper has. The overhead versus a two-statement version is only the
  non-selected sports' series/recents (a capper's picks partition by sport, so
  it is bounded by the capper's own decided count), and it saves a serialized
  round trip and keeps tab list and content from one snapshot (two statements
  could straddle a grading write). If EXPLAIN shows the single statement is slow
  for tail cappers, splitting at the selection boundary is the fallback.
- **`getCappersWithPickCounts`** loads full `capper` rows for the whole roster
  only for `otherCappers` (the merge dialog in `CapperEditPanel`). Two options,
  neither required for the egress goal: (a) narrow it to
  `select { id, name, _count }` (same RT, roughly an order of magnitude less payload [ESTIMATE]), or (b) load the
  list on demand when the merge dialog opens via a server action (removes the RT
  from every page load). (b) is a UI change → Q5.
- **Latency is not guaranteed lower for a tiny capper** (one long statement with
  window functions vs four short ones; same caveat #130 §5 made). The plan and
  wall time are measured, not asserted (§8).

## 7. Caching

I do not assume caching helps. After the migration a miss costs one statement
and ~10 KB, so the absolute saving of a hit is small.

### Dashboard — keep as is

`getDashboardSummary` already uses `cachedByTag(dashboard:${userId}, 60 s)`.
Nothing changes except that the cached value shrinks (it already excludes the raw
array; the chart is ≤ 2,000 points). Invalidation coverage is the existing
contract (`docs/cache-invalidation-contract.md`, P1–P8 tagged, P9 TTL-only).

### Capper detail — **no cache in the first capper PR; a follow-up only if logs justify it**

Shape if added: `cachedByTag(key, 60, fn, [cacheKeys.dashboard(userId)])` —
`cachedByTag` **already takes a separate `tags` argument** (the #130 doc's
"one string as both key and tag" note is out of date; `getCapperPanels` uses it),
so no helper change and the entry is invalidated by the existing
`revalidateTag(cacheKeys.dashboard(userId))` from every mutation path.

- **Key cardinality.** The brief's `(userId, capperId, window, categorySport)`
  omits **`categoryWindow`**, an independent param with its own default
  (`page.tsx:70`); leaving it out would serve one `categoryWindow`'s numbers for
  another — a silent wrong-number bug. The correct key is
  `(userId, capperId, window[6], categoryWindow[6], categorySport[≈ sports + unset])`
  ≈ up to 36 × 3–4 ≈ **110–140 entries per (user, capper)** [ESTIMATE]; across
  a 110-capper roster the space is ~10⁴ entries of ~8 KB, almost all single-use.
  A component split (all-time block keyed `(user, capper)`; `window` block keyed
  by window; sport block keyed `(categoryWindow, sport)`) cuts that to ≈ 25 per
  capper but turns one cold-navigation into up to three statements, worse than
  today's single-statement miss. Neither is attractive.
- **Hit pattern.** Repeat visit to the same capper with default params within 60 s
  hits; every first click on a window/sport chip misses; no cross-capper reuse.
  **Low–moderate [ESTIMATE]**, no measured data.
- **Invalidation coverage.** Tag is per **user**, not per capper, so any pick
  mutation on any capper evicts all of that user's capper-page entries
  (over-invalidation; harmless). A per-capper tag would need every mutation path
  to know the capper id — the cron (P8) only tracks `changedUserId`, so it is not
  free. Coverage: P1–P8 ✅ tagged. P9 (page-load grading) runs on `/picks` and
  `/live/[gameId]`, not on this page, and is bounded by the 60 s TTL. Time-relative
  windows (`TODAY`, `LAST_7`, …) use `now` at compute time, so a hit is up to 60 s
  stale on the boundary — the same tolerance the dashboard has.
- **What must stay out of the cached value:** anything from the `capper` row
  (name, colour, source). Those are read live by `getCapperById`; `renameCapperAction`
  tags, but colour/source edits (if any exist) would not, and the payload has no
  need for them.
- **Cost.** A cached-payload change also needs a new row in the contract doc's
  surface table and a mutation-path audit, per that doc's own rule.

## 8. Parity test plan

Follows #130 §8 (build → harness diff → cutover → observation → remove old) and
extends the T2 harness (`scripts/t2-harness/`: `capture-output.ts`,
`capture-picks-by-capper.ts`, `run-diff*.mjs`).

**Setup**

- `legacy` = a frozen copy of today's JS path, kept only for the rollout:
  `computeDashboardSummary` and the capper page's derivation extracted to a pure
  function `computeCapperDetailLegacy(picks, params, now)`. The legacy copy takes
  an explicit `now` and feeds rows in **explicit total order**
  (`gameTime, createdAt, id`) — the same reference-order device #130 used — so
  the tie-break PR's JS sorts and the SQL path are compared on equal footing.
- The run stamps categories first (`backfill-pick-category --apply` on the
  disposable DB), as #130 §8 requires; on the snapshot that proves **SQL ≡ JS
  given identical stamps**, not that production's stamps are right (that is
  G1's `--verify`).
- **`now` pinned and swept.** The snapshot predates today, so `TODAY`/`LAST_7`
  would be empty at the real `now`. The harness runs each scenario at several
  instants inside the data range (snapshot date, −1 d, −7 d, −30 d, −60 d) and
  passes the same instant to both sides.
- **Micro-tests before any of that** (no DB, seconds): (1) `d ** 2 === d * d`
  over 10⁷ random doubles on the project's Node; (2) `float8` → `jsonb` →
  `JSON.parse` round-trip is the identity over 10⁶ random doubles including
  subnormals and 1e±300, against the Supabase-equivalent Postgres major version
  (`SHOW server_version`); (3) the SQL round-half-up expression equals
  `Math.round(x*100)/100` over 10⁶ random and all exact-`.5` cases;
  (4) `downsampleUnitsChart` vs the SQL bucketer on synthetic monotonic,
  oscillating, all-equal, `n = 2000 / 2001 / 2002`, and `n = 20,000` series.

**Dashboard scenarios** (per snapshot user): the full summary object, deep-equal
except `currentStreak/longest*` (unread, dropped from the shape — Q4). Includes
the heaviest account (4,291 picks — **[UNVERIFIED]** that it has > 2,000 *decided*
picks; if not, the > 2,000 branch is covered by the synthetic 5k/20k user), a user
with zero picks, a user with only `PENDING`, and one with `CANCELLED`-with-`gradedAt`.

**Capper detail scenarios:** every `(user, capper)` × `window` × `categoryWindow` ×
`categorySport ∈ {unset, each sport the capper has, one sport the capper lacks}` is
≈ 36 × 4 per capper × 110 cappers ≈ 16k combinations for the heaviest user — run
the **full matrix** for the 10 heaviest cappers plus a stratified random 20, and
the diagonal (`window = categoryWindow`, default and each sport) for all the rest,
at every pinned `now`. Also: a capper with zero picks, only `PENDING`, only
`PUSH`, exactly 4/5/6 decided (consistency gate 5, odds-range gate 3), one sport
only, two sports tied on tile total (tie-break via `firstKey`), and the two hardest
momentum inputs (alternating W/L, and a 12-long run so the `"4+"` bucket and
run-boundary are exercised).

**Comparison rules**

- **Displayed values: zero diffs**, `===` (with `-0` ≡ `+0`), including array
  order (tabs, tiles, best-range choice, recent lists) — see §5 for the tolerance
  stance.
- **Ordering-sensitive fields** (`streak`, recents, chart order, momentum,
  consistency, tab ties) get the same two comparisons as #130 §8: (1) unordered
  legacy vs SQL — diffs permitted **only** where a same-`gameTime` tie straddles
  the boundary, each printed and reviewed; (2) `legacy-with-explicit-total-order`
  vs SQL — **zero diffs, hard gate**. Since the tie-break PR is assumed merged,
  (2) is the gate and (1) is characterization only.
- **Synthetic acceptance tests** (disposable DB, style of
  `capper-list-aggregates-acceptance-test.ts` and
  `capper-recent-picks-acceptance-test.ts`): the window predicate per window incl.
  `gradedAt IS NULL` outside `ALL` and a `CANCELLED`-with-`gradedAt` pick making a
  window "non-empty"; `PUSH` in the chart (a flat point) but invisible to streak
  and momentum; `NULL` category counted in totals/chart/streak but in no tile;
  unstamped (`categoryVersion = 0`) row absent from tiles (documents G4);
  sport-name case sensitivity; `odds = 0` WIN reproducing the JS poison on totals
  and series; two sports tied; `LIMIT 10` recents across ties on `gameTime`.
- **Performance checks** (snapshot, not production): `EXPLAIN (ANALYZE, BUFFERS)`
  of the dashboard bundle (whole-history user) and the capper bundle (tail
  capper) — confirm one materialized scan of the user's/capper's picks, the
  `(userId, capperId)` / `(userId, status)` indexes, and that the
  `generate_series` bucketer is negligible; wall time legacy vs SQL through the
  real client with query logging on (also settles the 4-statement baseline).

## 9. Estimated payload, before and after

**All [ESTIMATE].** Inputs: step-2 snapshot measurements — heaviest account 4,291
picks / 110 cappers (mean ≈ 39 picks/capper), 274.5 B/row raw, 325.7 B/row joined
to `sports`; the investigation's ~550 B/row for `include {capper, sport, league}`
(Prisma dedupes relation rows per distinct id, so the relation cost is per
distinct capper/sport/league, not per pick). Raw column size is a lower bound on
wire bytes. Tail = 3× mean.

**Dashboard (cold miss)**

| Account | Before | After |
|---|---|---|
| Small, ~500 picks | 500 × ~275 B ≈ **140 KB** | series ≤ 500 × ~26 B ≈ 13 KB + ~4 KB (tiles ≤ 6 rows, recent 10, counts) ≈ **17 KB** (~88 % less) |
| Heaviest snapshot, 4,291 picks | ≈ **1.2 MB** | series capped at ≤ 2,000 × ~26 B ≈ 52 KB + ~4 KB ≈ **56 KB** (~95 % less) |
| Power user, 20,000 picks | ≈ **5.5 MB** | ≈ **56 KB** (~99 %) — and only because the bucketing runs in the DB; the raw-series fallback would be ≈ 520 KB |

**Capper detail (every load)**

| Capper | Before (rows × ~550 B) | After |
|---|---|---|
| Mean, 39 picks (~30 decided) | ≈ **21 KB** | totals ~0.4 KB + tiles ~2 KB + series 2 × 30 × 26 B ≈ 1.6 KB + recents ~2.5 KB + momentum/odds/consistency/meta ~2 KB ≈ **8–9 KB** (~60 % less) |
| Tail, ~120 picks | ≈ **66 KB** | ≈ **14 KB** (~80 %) |
| Heaviest, 4,291 picks | ≈ **2.4 MB** | series 2 × 4,291 × 26 B ≈ 220 KB + ~10 KB ≈ **230 KB** (~90 %) |

Honest reading: for a *typical* capper the byte saving is modest and the RT saving
(7 → 4) matters more; the byte win is concentrated in heavy cappers and heavy
accounts. The floor on the capper page is the full-fidelity chart series (kept for
numbers-must-not-change). If that is the remaining lump, Q7 is the lever.

**Statement count** is in §6. **App-server CPU** also drops: no `pickCategory` over
the full history (called once per pick, several times per render today), no
O(n²) momentum, no per-window array filters.

## 10. Proposed PR split

Each PR shippable alone, in order. **[MR]** = touches stats logic / displayed
statistics → ships as a PR for manual review, never auto-merged.

1. **Docs** — this document.
2. **Shared building blocks + verification harness (no behavior change) [MR]**
   — the fragments and row mappers of §3–§4 (nothing wired to a page); the
   `capper-list-aggregates.ts` refactor of `queryWindowTotals` into a fragment plus
   its `groupBySport` option (its existing acceptance test is the guard); the
   JS finalizers extracted from `stats.ts` (`categoryBreakdownFromCounts`,
   `bestOddsRangeFromRows`, `consistencyFromTotals`, and parameter-type narrowing
   of `computeMomentum`/`computeUnitsChartData` — *no logic change*, but it edits
   `stats.ts`, hence [MR]); the §8 micro-tests; the `legacy` copies and harness
   capture entry points; synthetic acceptance tests. Gate: micro-tests pass and, if
   #130's G1 `--verify` has not been run against production, that too.
3. **Dashboard [MR]** — `computeDashboardSummary` on one statement; `overall`
   narrowed to the fields the page reads (Q4); the harness diff attached; the
   cache and page unchanged. If Q1 is answered "yes", the panels migration is its
   own later PR, not folded in.
4. **Capper detail [MR]** — `getCapperDetailData` bundle (one statement), the page
   rewired to consume it, `getPicksForCapper` un-called from the page (it stays for
   `capper-comparison.ts`), `getCappersWithPickCounts` narrowed. Atomic per page:
   the egress win only exists once **every** section moved, because any one
   remaining consumer of the raw array keeps the full fetch, so this cannot be
   usefully split section by section.
5. **Optional: capper-detail cache** — only if post-migration logs show repeat
   loads matter; adds the contract-doc row (§7).
6. **Removal** — delete the legacy copies and (once nothing else calls them)
   any dead JS helpers, after an observation period, per #123/#130 convention.

**Order.** Blocks → dashboard → capper detail, as proposed, is right *for risk*:
the dashboard has one scope (all-time, all sports, no windows, no per-sport
selection, no momentum) but still exercises the hardest shared primitive — the
downsampled series — so bit-exactness is proven on a smaller surface before the
capper page adds the window × sport dimension. The counter-argument is egress:
the capper page is uncached and refetches on every chip click, so per unit of
work it is the larger offender, and dashboard is already 60 s-cached. If egress
priority outweighs risk, swap 3 and 4; PR 2 does not change. I would not
reorder unless the logs say the capper page dominates.

## 11. Open questions

- **Q1 — `getCapperPanels` also reads full history** (`capper-panels.ts:142-159`,
  unbounded `pick.findMany`, uncached on the first hit per 60 s per user). Is it
  in scope? As written this design migrates only `getDashboardSummary`; without
  panels, `/dashboard` still reads full history on a cold miss and its payload
  claim halves. Recommendation: separate design + PR (its windows — last 5/8/10/20
  decided, 14-day activity, lifetime — are a different set of ordered-window
  problems), tracked now so the dashboard PR does not overclaim.
- **Q2 — SQL twins of momentum / consistency / best-odds-range.** These are new
  SQL implementations of existing JS algorithms; the project convention is to
  extend rather than parallel (§4). Recommendation: SQL for all three (O(n²)
  momentum goes away, output ≤ ~1 KB, parity is exact-checkable, and the JS side
  shares its finalizers), with each raw-series fallback documented and ready.
  Confirm, or choose the narrow-series route (`(status, units, odds)` ordered, JS
  unchanged) for any of them.
- **Q3 — one statement vs "tabs first".** §6 recommends one statement returning
  per-sport selection-dependent parts. Confirm, or prefer two statements for
  smaller payload on multi-sport cappers.
- **Q4 — drop the unread `overall` fields.** The dashboard page reads only
  `wins, losses, pushes, roi, netUnits` of `overall`; `currentStreak`,
  `longest*Streak`, `winPct`, `unitsWon`, `unitsLost` are computed and never
  rendered (nor by any other `getDashboardSummary` caller — the page is the only
  one). Dropping them removes a streak query from the dashboard. OK to narrow the
  cached shape?
- **Q5 — merge dialog's capper list.** Narrow `getCappersWithPickCounts` (same RT)
  or defer it to on-open via a server action (−1 RT per page load, small UI
  change)?
- **Q6 — `CHECK (odds <> 0)`.** Both creators reject it and the step-2 snapshot had
  zero such rows, but it is not structural. A migration (validated after a prod
  `count(*) WHERE odds = 0` = 0) would delete the poison-reproduction paths from
  the series/momentum/consistency work. Worth a separate tiny PR before PR 2, or
  keep carrying the flag paths?
- **Q7 — capper-page chart fidelity.** Full fidelity is kept (numbers must not
  change). If a 4,000-point capper chart is acceptable to bucket like the
  dashboard's, the series payload on tail cappers drops ~90 % more — an explicit
  product decision, not part of this migration.
- **Q8 — caching the capper page.** Recommendation: not in the first PR (§7).
  Confirm, and confirm `categoryWindow` belongs in any future key.
- **Q9 — `now` semantics.** Windows use one `now` per request today. A cached
  entry freezes it for ≤ 60 s. Acceptable on the capper page as it is on the
  dashboard?
