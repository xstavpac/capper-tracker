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

Recorded from the review of PR #135 (full list with evidence in §11): Q1 panels out
of scope; **Q2 no SQL twins — momentum/consistency/odds-range run the existing JS
on a narrow raw series**; Q3 one statement for the capper page; Q4 drop unread
dashboard `overall` fields (grep evidence in §11); Q5 narrow
`getCappersWithPickCounts` now; Q6 no `CHECK`, keep zero-odds flag paths; Q7
capper chart stays full fidelity; Q8/Q9 no capper-page cache; PR order blocks →
dashboard → capper detail.

From the original brief:

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
history; **out of scope (Q1, DECIDED)** — the dashboard PR must not claim otherwise.

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
(Q6, DECIDED: not added; the flag path stays). (2) **jsonb round-trip of `float8`** must be shortest-round-trip (PG ≥ 12
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
- **Capper detail: not used.** DECIDED (Q2/Q7): the capper page's charts are
  computed from the narrow raw series of §4 by the existing
  `computeUnitsChartData`, at full fidelity. This SQL series (and its
  running-flag/bucketing machinery) is **dashboard-only**.
- **Labels:** the fragment returns `gameTime` as epoch ms; the mapper builds
  `date: formatEastern(new Date(t), { month: "short", day: "numeric" })` in JS —
  no `to_char`/ICU locale parity risk, and the same function as today.

Output shape (dashboard): `Array<{ t: number; run: number; flags?: number }>` →
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

## 4. Capper-detail-only sections — one narrow raw series, existing JS

**DECIDED (Q2): no SQL twins.** Momentum, consistency and best odds range are
computed by the *existing* JS functions (`computeMomentum`, `computeConsistency`,
`computeBestOddsRange`) over a narrow, ordered raw series the capper statement
returns — one implementation of each algorithm. Two consequences follow from the
same rule and are recorded here rather than left implicit: the capper page's
**units charts** and its **all-time current streak** are also derived from that
series by the existing `computeUnitsChartData` / `currentStreak`, so the
capper-page SQL series and the streak fragment proposed in the first draft are
gone (the SQL cumulative series of §3.c is now dashboard-only). Q11 asks for
confirmation of the streak change.

### 4.1 The series

The capper's **decided** picks (`WIN`/`LOSS`/`PUSH`), whole history, no relations
(the sport name comes from a `JOIN sports`, one column), ordered by `ORDER`
(`gameTime, createdAt, id COLLATE "C"`), scoped `userId = $u AND capperId = $c`
(existing `(userId, capperId)` index). Minimum column set and who reads each:

| Column | Read by |
|---|---|
| `id`, `createdAt` | the canonical tie-break inside the JS sorts (the assumed-merged `stats.ts` PR sorts on `gameTime, createdAt, id`); rows arrive already ordered, but the comparator must see the fields, so they ride along rather than making the existing sorts conditional |
| `gameTime` | every sort, `filterPicksByGameWindow`, the chart's `date` label |
| `gradedAt` | `filterPicksByGameWindow`'s non-`ALL` gate (only whether it is set matters, but the function takes the `Date`) |
| `status` | every consumer |
| `units`, `odds` | `unitsWonOnBet`, consistency returns, `oddsBucket`, momentum `netUnits`, chart |
| `sport` (name) | the sport-scoped chart (`categoryWindow` × selected sport) |

Times travel as epoch-ms `bigint` (the existing `round(extract(epoch FROM …) * 1000)`
construction; exact for `timestamp(3)`) and become `new Date(ms)`; `gradedAt` is
`null` or ms. Everything else a JS function reads off `Pick` is *not* fetched:
no `betDetail`, `homeTeam`, notes, `pickedSide`, category, etc. **Excluded rows:**
`PENDING`/`CANCELLED` (no consumer below reads them; recents come from §3.d,
"is the windowed set non-empty" from `nPicks` in §3.a).

The JS functions take `Pick[]` today; their parameter types narrow to a
structural row type (`Pick<PrismaPick, "id"|"createdAt"|"gameTime"|"gradedAt"|"status"|"units"|"odds"> & { sport: { name: string } }`
for `computeStats`, `currentStreak`, `computeMomentum`, `computeConsistency`,
`computeBestOddsRange`, `computeUnitsChartData`). **Types only; no logic
change.**

### 4.2 Sections and their source

| Section | Source | Notes |
|---|---|---|
| **Tracked since / last pick / pick count** | SQL aggregates over **all statuses**: `min("datePosted")`, `max("datePosted")`, `count(*)` (epoch-ms as above). `count(*)` = `associatedPickCount` = the `ALL`-window `nPicks` | the series is decided-only, so it cannot supply these |
| **Current streak** (all-time) | `currentStreak()` over the series (it filters to W/L itself) | replaces `queryCurrentStreaks` for this page |
| **Momentum** | `computeMomentum(series)` | unchanged algorithm, including its O(n²) prefix scan — see below |
| **Best odds range** | `computeBestOddsRange(series)` | tie-by-first-appearance rule is inherited, not re-derived |
| **Consistency** | `computeConsistency(series)` | label only is rendered; `cv` unchanged |
| **Units chart, `window`** | `filterPicksByGameWindow(series, window)` → `computeUnitsChartData` | full fidelity, no downsampling (Q7) |
| **Sport chart, `categoryWindow`** | series filtered to the selected sport → `filterPicksByGameWindow(…, categoryWindow)` → `computeUnitsChartData` | selected sport is known in JS after the tiles are read |
| Hero stat cards, sport strip | totals, §3.a | SQL sums, as #123 |
| Category tiles, sport tabs | §3.b | SQL grouped counts on the stored `category` |
| Recents | §3.d | needs all statuses and the newest-N per sport, so not derivable from the decided series |

**Momentum's O(n²) stays.** Not fixing it is the price of one implementation. At
the heaviest snapshot capper (≤ 4,291 decided) the prefix scan is ~10⁷ element
operations, tens of milliseconds on the app server **[ESTIMATE]**. A future change
to the JS algorithm itself (still a single implementation) is possible and
independent of this migration.

### 4.3 Consequences for parity and payload

- **Parity is by construction for these sections.** The same functions run on
  the same per-pick values; SQL does no float math for them. What has to be
  tested is the *narrowing*: right rows, right order, exact `Date` round trip,
  `gradedAt` null-ness, `units`/`odds` through `jsonb` (§5, §8).
- **Zero-odds needs no SQL flag on this page.** The JS functions reproduce their
  own `Infinity`/`NaN` on a `WIN` at `odds = 0` natively (Q6: flag paths stay,
  but only totals and the dashboard series need them).
- **One series serves six consumers** (streak, momentum, odds range, consistency,
  both charts), instead of two SQL series plus three SQL twins. The payload is
  the series: ≈ 120 B per decided row as JSON objects **[ESTIMATE]** (three
  epoch-ms numbers, a 25-char id, status, units, odds, sport name); array
  encoding would roughly halve it if it ever matters.

## 5. Money parity

Money-bearing outputs: dashboard `overall.roi / netUnits`, recent-pick `units`
(pass-through of a `Float`), chart `cumulativeUnits`; capper page `roi / netUnits`
(hero + sport strip), chart, momentum `netUnits`, consistency `cv`, recent-pick
`odds/units`. **Per Q2, on the capper page only the totals (§3.a) involve SQL float
math**; chart, momentum, consistency and odds range are the existing JS over raw
`units`/`odds`, so their float behavior (summation order, rounding, `-0`,
zero-odds) is the current JS behavior, unchanged.

| Concern | Position |
|---|---|
| **Per-pick value** | `units * (odds/100)` / `units * (100/abs(odds))` in `float8` via `WIN_UNITS` — the same IEEE double as `unitsWonOnBet`. Never `/ 100.0` (numeric division). Reused verbatim (exported). |
| **Summation order** | JS adds in `gameTime, createdAt, id` order (assuming the tie-break PR). SQL uses `sum(x ORDER BY <ORDER>)` for aggregates and `ROWS UNBOUNDED PRECEDING` running windows — sequential, **not** the planner's arbitrary/parallel partial-aggregate order, which is exactly why #123 uses ordered aggregates. The `FILTER` reproduces JS's per-status accumulators (`unitsWon` over WINs only, `unitsLost` over LOSSes, `unitsRisked` over W/L/P). |
| **Rounding** | All rounding stays in JS `round2` (`recordStatsFromTotals`, `toRows`, the chart mapper) applied to unrounded SQL totals. The single SQL rounding is the half-up expression in §3.c, used only for downsample comparisons. `round(float8)` (half-even) / `round(numeric)` (half away from zero) are both **wrong** for `Math.round`'s ties-toward-+∞ and must not appear. |
| **`-0`** | `sum` of a lone `-units` with `units = 0` or `Math.round(-0.3)` yield `-0`; `+ 0.0` normalizes on the SQL side. Displays are unaffected (`(-0 >= 0 ? "+" : "") + -0` → `"+0"` both sides) but the parity comparator must treat `-0` and `+0` as equal (or normalize), not fail on `Object.is`. |
| **`odds = 0`** | Cannot be created (both creators reject it). If a row exists: `float8` division by zero errors in Postgres, so the `NULLIF` guard stays; totals reproduce JS poison via `zeroOddsWinFlags` + `zeroOddsWinUnitsWon` (existing); the dashboard series carries a running flag (§3.c); the capper page's JS functions reproduce it natively — **reproduced, not fixed**. **DECIDED (Q6): no `CHECK (odds <> 0)` for now; the flag paths stay.** Prod count of `odds = 0` rows must be re-checked when the harness runs (the step-2 snapshot had zero). |
| **`float8` → JS** | `$queryRaw` returns `float8` as a JS number (exact). Through `jsonb` it goes `float8out → numeric → JSON text → JSON.parse`; exact iff Postgres emits the shortest round-trip form (PG ≥ 12). Verified by test, not assumed (§8). |
| **How exact can the parity test be?** | **Bit-exact is the target for every number**, because both sides perform the same IEEE operations in the same order on the same per-pick doubles. Gate: every *displayed* value (everything after `round2`/`winPctOf`, every label, every count, every ordering) is `===`-equal (zero diffs). Reported but **non-gating**: any ULP difference in an *unrounded* intermediate (raw `unitsWon` sums, the dashboard series' unrounded `run`) that does not change a rounded value or label — each one is printed and reviewed, because it would indicate an ordering or operation mismatch worth understanding. No display-rounding tolerance is applied silently (unlike step 2's 2-decimal tolerance); a diff in a displayed value is a bug. |

## 6. Round trips per page load, before and after

`connection_limit=1` serializes every statement an instance issues. Baselines
assume the Prisma 5 `query` strategy (**[UNVERIFIED]**, settled by the same
`log: ["query"]` run as #130 §1.1). "RT" = statements.

| Page / state | Today | After |
|---|---|---|
| `/dashboard`, summary **cold** | user 1 + summary **4** + panels **2** (`capper` + `pick`, by `getCapperPanels`) + plan **2** = **9** | user 1 + summary **1** + panels 2 + plan 2 = **6** (panels out of scope, Q1) |
| `/dashboard`, summary **warm** (60 s TTL) | user 1 + plan 2 = **3** | unchanged **3** — the win is the cold miss, which recurs after every `revalidateTag` (each grade/mutation for that user) |
| `/cappers/[id]`, every load | user 1 + capper 1 + picks **4** + capper list 1 = **7** | user 1 + capper 1 + **bundle 1** + narrowed capper list 1 = **4** |

- **DECIDED (Q3): one statement for the capper page.** The dependency (selected
  sport ← all-time tab list) is resolved in JS by returning the
  selection-dependent parts for **every** sport the capper has: per-sport
  `categoryWindow` totals (§3.a `groupBySport`), per-sport recents (§3.d), and the
  decided series (§4), which is sport-tagged and already covers every sport. The
  overhead versus a two-statement version is only the non-selected sports'
  totals/recents rows; the series is needed in full either way. It saves a
  serialized round trip and keeps tab list and content from one snapshot (two
  statements could straddle a grading write). If EXPLAIN shows the single
  statement is slow for tail cappers, splitting at the selection boundary is the
  fallback.
- **DECIDED (Q5): `getCappersWithPickCounts` is narrowed now** to
  `select { id, name, _count: { select: { picks } } }` — same one statement,
  roughly an order of magnitude less payload than full `capper` rows for the
  whole roster **[ESTIMATE]**, no UI change. Loading the list on demand when the
  merge dialog opens (which would remove the statement from every page load) is
  **deferred**; it is a UI change and is not part of this migration.
- **Latency is not guaranteed lower for a tiny capper** (one statement with
  several CTEs vs four short ones; same caveat #130 §5 made). The plan and wall
  time are measured, not asserted (§8).

## 7. Caching

I do not assume caching helps. After the migration a miss costs one statement
and ~10 KB, so the absolute saving of a hit is small.

### Dashboard — keep as is

`getDashboardSummary` already uses `cachedByTag(dashboard:${userId}, 60 s)`.
Nothing changes except that the cached value shrinks (it already excludes the raw
array; the chart is ≤ 2,000 points). Invalidation coverage is the existing
contract (`docs/cache-invalidation-contract.md`, P1–P8 tagged, P9 TTL-only).

### Capper detail — **DECIDED (Q8): no cache in the first capper PR**

After the migration a miss costs one statement and ~10–20 KB (larger for heavy
cappers), so the absolute saving from a hit is small and the key space is large.
Recorded for a possible later follow-up, only if post-migration logs show repeat
loads matter:

- **Any future key must include `categoryWindow`.** The page has three
  independent params — `window`, `categoryWindow`, `categorySport`
  (`page.tsx:57-70, 78`). A key of `(userId, capperId, window, categorySport)`
  would serve one `categoryWindow`'s numbers for another, a silent
  wrong-number bug. The full key is
  `(userId, capperId, window[6], categoryWindow[6], categorySport[≈ sports + unset])`
  ≈ 110–140 entries per (user, capper) **[ESTIMATE]**, mostly single-use.
- **Mechanics if it is ever added.** `cachedByTag(key, 60, fn, [cacheKeys.dashboard(userId)])`
  — `cachedByTag` already takes a separate `tags` argument (`getCapperPanels`
  uses it; #130's "one string as both key and tag" note is out of date), so the
  existing `revalidateTag(cacheKeys.dashboard(userId))` from P1–P8 covers it;
  P9 is bounded by the 60 s TTL. The tag is per user, so any pick mutation evicts
  all of that user's capper entries (harmless over-invalidation; a per-capper tag
  would need the cron, which only tracks `changedUserId`, to learn capper ids).
  The cached value must contain no `capper`-row fields, and the contract doc's
  surface table and mutation audit must get a row first.
- Because nothing is cached, `now` is taken per request and the question of
  freezing `now` for 60 s does not arise (Q9, moot).

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
- **Micro-tests before any of that** (no DB, seconds): (1) `float8` → `jsonb` →
  `JSON.parse` round-trip is the identity over 10⁶ random doubles including
  subnormals and 1e±300, against the Supabase-equivalent Postgres major version
  (`SHOW server_version`); (2) the SQL round-half-up expression equals
  `Math.round(x*100)/100` over 10⁶ random and all exact-`.5` cases;
  (3) `downsampleUnitsChart` vs the SQL bucketer on synthetic monotonic,
  oscillating, all-equal, `n = 2000 / 2001 / 2002`, and `n = 20,000` series;
  (4) the narrow-series row round trip: `bigint` epoch-ms → `new Date` equals the
  original `timestamp(3)` value, `gradedAt` null stays null. (The earlier
  `d ** 2` vs `d * d` micro-test is dropped with the SQL consistency twin.)

**Dashboard scenarios** (per snapshot user): the full summary object, deep-equal
except `currentStreak/longest*/winPct/unitsWon/unitsLost` of `overall` (unread, dropped from the shape — Q4, evidence in §11). Includes
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
only, two sports tied on tile total (tie-break via `firstKey`), and momentum inputs
alternating W/L and a 12-long run (`"4+"` bucket). Momentum, consistency, odds
range, streak and the charts run the same JS on both sides, so the capper
comparison for them verifies the **narrowing** (row set, order, dates, nulls),
not the math.

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

**Dashboard (cold miss)** — unchanged by the review decisions

| Account | Before | After |
|---|---|---|
| Small, ~500 picks | 500 × ~275 B ≈ **140 KB** | series ≤ 500 × ~26 B ≈ 13 KB + ~4 KB (tiles ≤ 6 rows, recent 10, counts) ≈ **17 KB** (~88 % less) |
| Heaviest snapshot, 4,291 picks | ≈ **1.2 MB** | series capped at ≤ 2,000 × ~26 B ≈ 52 KB + ~4 KB ≈ **56 KB** (~95 % less) |
| Power user, 20,000 picks | ≈ **5.5 MB** | ≈ **56 KB** (~99 %) — and only because the bucketing runs in the DB; the raw-series fallback would be ≈ 520 KB |

**Capper detail (every load)** — revised for the narrow raw series (§4). Model:
series ≈ 120 B × decided rows (all sports, one copy serving every consumer) +
~6 KB fixed (totals ~0.4 KB, tiles ~2 KB, per-sport recents ~2.5 KB, meta, narrowed
capper list for a small roster) **[ESTIMATE]**.

| Capper | Before (rows × ~550 B) | After |
|---|---|---|
| Mean, 39 picks (~30 decided) | ≈ **21 KB** | 30 × 120 B ≈ 3.6 KB + ~6 KB ≈ **~10 KB** (~55 % less) |
| Tail, ~120 picks (~90 decided) | ≈ **66 KB** | ≈ 10.8 KB + ~6 KB ≈ **~17 KB** (~75 % less) |
| Heaviest, 4,291 picks | ≈ **2.4 MB** | ≈ 4,291 × 120 B ≈ 515 KB + ~6 KB ≈ **~520 KB** (~78 % less; ~300 KB with array encoding) |

Honest reading, changed by Q2/Q7: the earlier draft's SQL series were narrower
(~26 B/point, ~90 % reduction on the heaviest capper). Choosing one
implementation of each algorithm and full-fidelity charts from raw rows makes the
**series the floor** — the byte win on heavy cappers is real but smaller, the win
on a typical capper is modest, and the round-trip saving (7 → 4) matters as much
as the bytes. Trimming the row (array encoding, dropping `id` if the JS sorts are
made tie-break-tolerant of presorted input) is the lever if the heaviest-capper
number ever matters; it is not proposed now.

**Statement count** is in §6. **App-server CPU** also drops: no `pickCategory`
over the full history (called once per pick, several times per render today) and
no per-window array filters over hundreds of full `Pick` objects; momentum's
O(n²) remains (§4.2).

## 10. Proposed PR split

Each PR shippable alone, in order. **[MR]** = touches stats logic / displayed
statistics → ships as a PR for manual review, never auto-merged.

1. **Docs** — this document.
2. **Shared building blocks + verification harness (no behavior change) [MR]**
   — the fragments and row mappers of §3 (nothing wired to a page): totals
   fragment with `groupBySport` (a refactor of `queryWindowTotals` into a fragment
   plus a thin wrapper; its existing acceptance test is the guard), tiles, the
   dashboard's downsampled SQL series, recents, pending counts, and the **decided
   narrow series** fragment of §4.1; the `categoryBreakdownFromCounts` finalizer
   (`computeCategoryBreakdown`'s tail refactored to call it); the structural
   parameter-type narrowing of §4.1 — *types only, no logic change*, but it edits
   `stats.ts`, hence [MR]; the §8 micro-tests; the `legacy` copies and harness
   capture entry points; synthetic acceptance tests. **Not in this PR (by
   decision): any SQL momentum/consistency/odds-range/streak implementation.**
   Gate: micro-tests pass and, if #130's G1 `--verify` has not been run against
   production, that too.
3. **Dashboard [MR]** — `computeDashboardSummary` on one statement; `overall`
   narrowed to the fields the page reads (Q4, evidence in §11); the harness diff
   attached; the cache and page unchanged. `getCapperPanels` is not touched
   (Q1).
4. **Capper detail [MR]** — `getCapperDetailData` bundle (one statement), the page
   rewired to consume it (existing JS functions over the narrow series), 
   `getPicksForCapper` un-called from the page (it stays for
   `capper-comparison.ts`), `getCappersWithPickCounts` narrowed to
   `id, name, count` (Q5). Atomic per page: the egress win only exists once
   **every** section moved, because any one remaining consumer of the raw array
   keeps the full fetch.
5. **Removal** — delete the legacy copies and any dead helpers, after an
   observation period, per #123/#130 convention. (The optional capper-detail cache
   PR of the first draft is dropped: Q8.)

**Order — DECIDED: blocks → dashboard → capper detail.** Reasoning kept: the
dashboard has one scope (all-time, all sports, no windows, no per-sport
selection) yet exercises the hardest shared primitive — the downsampled series —
so bit-exactness is proven on the smaller surface before the capper page adds the
window × sport dimension. The capper page is the larger per-load offender
(uncached, refetched on every chip click); that is accepted.

## 11. Decisions and open questions

Recorded from the review of PR #135. **DECIDED** items are not re-litigated.

- **Q1 — `getCapperPanels`. DECIDED: OUT of scope.** It also reads full history
  (`capper-panels.ts:142-159`); it gets its own design and PR later. Consequence:
  the dashboard PR must not claim `/dashboard` stops reading full history — only
  `getDashboardSummary` does; the panels read is called out in §1.1 and §6.
- **Q2 — SQL twins. DECIDED: NO twins** for momentum, consistency, best odds
  range. They use the narrow raw series of §4 fed to the existing JS functions
  (minimum columns, no relations, canonical tie-break order). Building blocks
  (§3, §4), round trips (§6), payload (§9) and PR split (§10) are updated.
- **Q3 — one statement for the capper page. DECIDED** (§6).
- **Q4 — unread dashboard `overall` fields. DECIDED: drop them, but only because
  the grep below confirms nothing reads them.** Evidence (run at `1659b23`+,
  repo `src/`, `scripts/`):
  - `grep -rn "getDashboardSummary\|computeDashboardSummary" src scripts` →
    the only **call** site is `src/app/(app)/dashboard/page.tsx:37`; every other
    hit is a comment (`bulk-picks.ts:691`, `actions/picks.ts:12`,
    `capper-panels.ts:130`, `units-chart-downsample.ts:9,39`) or its own
    definition in `stats.ts`. No test or script references it.
  - `grep -rn "DashboardSummary\|ReturnType<typeof getDashboardSummary"` finds
    no type alias that re-exports the shape.
  - In that page the summary is destructured as
    `{ overall, chartData, stalePendingCount }` and read only as
    `overall.wins`, `overall.losses`, `overall.pushes` (line 69),
    `overall.roi` (75, 79), `overall.netUnits` (87, 91), `summary.totalPicks`
    (56), `summary.pendingCount` (95), `summary.categoryBreakdown` (113, 116),
    `summary.recentPicks` (130, 135), plus `chartData` / `stalePendingCount`.
    `overall.currentStreak`, `longestWinStreak`, `longestLossStreak`, `winPct`,
    `unitsWon` and `unitsLost` are never read. (The `entry.stats.currentStreak`
    hits in `cappers-leaderboard-table.tsx` / `favorite-cappers-summary.tsx` are
    leaderboard/favorites data, not the dashboard summary.)
  - **The PR must re-run these greps and paste the result** before removing the
    fields; if any new reader has appeared, the field stays.
- **Q5 — `getCappersWithPickCounts`. DECIDED: narrow to `id, name, count` now.**
  On-demand loading for the merge dialog is **deferred** (§6).
- **Q6 — `CHECK (odds <> 0)`. DECIDED: none for now.** The zero-odds flag paths
  stay (totals via `zeroOddsWinFlags`; the dashboard series via its running
  flag). The capper page needs no flag path (§4.3).
- **Q7 — capper-page chart fidelity. DECIDED: stays full fidelity**, now
  computed from the narrow series by the existing `computeUnitsChartData` (§4).
- **Q8 — caching the capper page. DECIDED: no cache in the first PR.** Any
  future key must include `categoryWindow` (§7).
- **Q9 — `now` freezing under a cache. DECIDED: moot** (no cache).
- **PR order. DECIDED:** blocks → dashboard → capper detail (§10).

**Still open (introduced by these decisions):**

- **Q10 — the dashboard's SQL series is the one remaining SQL twin.** Q2 named
  the capper-only sections; the dashboard's running-sum + bucketing SQL (§3.c) is
  a SQL implementation of `computeCumulativeUnitsSeries` +
  `downsampleUnitsChart`. It stays as designed — the alternative is shipping every
  settled row (≈ 520 KB at 20k picks) — with the §3.c raw-series fallback if the
  bit-exact parity gate fails. Confirm that Q2's "no twins" does not extend to it.
- **Q11 — capper-page current streak from the series.** Applying Q2's rule, the
  all-time streak now comes from `currentStreak()` over the narrow series rather
  than the gaps-and-islands SQL (`queryCurrentStreaks`, which keeps serving
  `/cappers`). Confirm, or keep a SQL streak for this page.
