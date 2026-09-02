# Moneyline favorite / underdog classification

**Status (2026-09-02):** Phase 1 shipped — forward-only. New bulk-imported
MONEYLINE picks now store the real favored side (`Pick.mlFavoredSide`) and
classify FAV_ML vs DOG_ML correctly, including in juiced near-pick'em games.
**No historical backfill and no historical stat recompute** — pre-existing picks,
manually entered picks, and imports where the market couldn't be resolved keep
falling back to the odds-sign heuristic. That backfill is a separate, later
decision (see §5).

---

## 1. The bug

`favoriteOrUnderdog` in `src/lib/bet-line.ts` classified a MONEYLINE pick from
nothing but the sign of the pick's own `odds`:

```
odds < 0  -> FAVORITE
odds > 0  -> UNDERDOG
odds == 0 -> null
```

It never saw the opponent's price, so it cannot actually determine favorite vs
underdog in a game where **both** moneylines are negative — which is how books
price any near-pick'em (e.g. Philadelphia Phillies **-112** vs Arizona
Diamondbacks **-104**, 2026-09-02). Both sides satisfy `odds < 0`, so a pick on
the Diamondbacks (the underdog) was counted as a `FAV_ML` pick.

**Amplifier:** `src/lib/parse-catalog.ts` defaults `odds` to `-110` for any pick
with no explicit price token (`parsed.odds ?? -110`, 11 call sites). Bulk import
tries to replace that with the real market price for the picked side, but when
the game doesn't resolve to a live odds row (off-season, team-name mismatch,
non-resolvable sport, game already started) the pick persists at `-110` and
classifies as a favorite regardless of which side it is on.

### Scope

Everything that classifies a pick by `pickCategory` / `favoriteOrUnderdog`:
Dashboard category panels, Reports (category breakdown **and** the by
Favorite/Underdog split), the Cappers page category chips/records, Sharp Money,
`computeSpecialistTag`, the game-detail expander records, and the Capper
Comparison Fav/Dog filter. Also the bulk-import duplicate checker
(`checkDuplicatePicksAction`), where a pick'em game's two opposite ML picks
classified identically and the real second-side pick got flagged as a duplicate.

**Not affected — verified independently:**

- **Grading.** `src/server/data/grading.ts` never calls `favoriteOrUnderdog` or
  `pickCategory`. A moneyline is graded purely on whether `pickedSide`'s team
  won. Win/loss and units are correct.
- **Team tendencies.** `recomputeTeamTendencies`
  (`src/server/data/team-tendencies.ts`) determines fav/dog by comparing the two
  moneyline prices from the odds snapshot (`homePrice < awayPrice`), not by odds
  sign. Independent, correct logic.

Nothing derived from the classification was ever persisted (no `category` or
fav/dog column on `Pick`), so the misclassification is entirely in the read
path: fix the function and every affected number recomputes correctly on the
next render. No `Pick`-row backfill is required for the classification itself.

---

## 2. Phase 1 fix (forward-only)

### New column

`Pick.mlFavoredSide PickedSide?` (`HOME` / `AWAY`), reusing the existing
`PickedSide` enum. Migration `20260902203916_add_pick_ml_favored_side` is a
single additive `ALTER TABLE "picks" ADD COLUMN "mlFavoredSide" "PickedSide"` —
existing rows get `NULL`, no data touched.

`HOME`/`AWAY` rather than a team name: classification is then a trivial
`pick.pickedSide === pick.mlFavoredSide` comparison — no team-name normalization
or fuzzy matching — and it is symmetric with the existing `pickedSide` column.
It is only usable when `pickedSide` is also present; both are captured in the
same `resolveGameAndOdds` pass under the same conditions, so in practice a
resolved single-side ML import gets both.

### Capture at import

`src/server/data/odds.ts`:

- `favoredSideFromOddsGame(oddsGame)` — pure. The favored side of a game's `h2h`
  market by `homePrice < awayPrice` (first bookmaker listing both sides wins),
  `null` on a missing market, a missing side, or exactly equal prices. Mirrors
  the `recomputeTeamTendencies` comparison, just off a single `OddsGame`.
- `findFavoredSide(sportKey, game)` — `resolveOddsGame` (same team-pair +
  closest-`commenceTime` match `findMarketPrice` uses) then
  `favoredSideFromOddsGame`. `null` when the game isn't in the odds cache (e.g.
  it has already started — `getOddsForSport` drops in-progress games) or has no
  usable `h2h` market.

`src/server/actions/bulk-picks.ts` → `resolveGameAndOdds` calls
`findFavoredSide` for `betType === "MONEYLINE"` only (SPREAD's fav/dog already
comes correctly off the line sign) and returns `mlFavoredSide`.
`bulkImportPicksAction` threads it into `PickInsertData` →
`createPicksWithEntitlementCheck` → `tx.pick.create`.

Cost: one extra `getOddsForSport(sportKey)` per bulk import containing at least
one MONEYLINE pick, per sport — memoized within the request (one indexed DB row
+ JSON parse), and already triggered for any no-explicit-odds pick in the same
batch.

### Classification

`favoriteOrUnderdog` (`src/lib/bet-line.ts`), MONEYLINE branch:

```
if (mlFavoredSide && pickedSide)  -> pickedSide === mlFavoredSide ? FAVORITE : UNDERDOG
else                              -> odds < 0 ? FAVORITE : odds > 0 ? UNDERDOG : null
```

`PickCategoryInput` gains optional `pickedSide` / `mlFavoredSide`; every real
`pickCategory` call site spreads a full `Pick` row, so the fields flow through
automatically. `checkDuplicatePicksAction` builds its `pickCategory` input by
hand and now passes both fields through (from `resolveGameAndOdds`), so the
pick'em false-duplicate is fixed too.

### Downstream consumers — no changes

Every category/fav-dog consumer already fetches full `Pick` rows (`include:`,
never a scalar `select` that would drop columns), so `pickedSide` +
`mlFavoredSide` reach `favoriteOrUnderdog` with zero consumer changes and simply
produce correct answers whenever `mlFavoredSide` is populated.

---

## 3. Tests

`src/server/data/ml-favorite-classification-acceptance-test.ts` (pure,
auto-discovered by `scripts/run-tests.mjs`):

- `favoriteOrUnderdog`: stored side wins (the Diamondbacks -104 case →
  `UNDERDOG`); `mlFavoredSide` null → odds-sign fallback (unchanged); stored side
  missing `pickedSide` → fallback; stored side overrides a positive price; SPREAD
  path untouched.
- `pickCategory`: Diamondbacks → `DOG_ML`, Phillies → `FAV_ML`, legacy
  null/null pick → `FAV_ML` (the documented, deliberately unchanged historical
  behavior).
- `favoredSideFromOddsGame`: -112/-104 → `HOME`; -104/-112 → `AWAY`; equal → `null`;
  missing side → `null`; no h2h → `null`.
- `computeCategoryBreakdown`: two opposite sides of one juiced pick'em now split
  into one `FAV_ML` + one `DOG_ML` (before: both `FAV_ML`).

---

## 4. Known accepted limitation

Picks created before this column, manually entered picks (`createPickAction` /
`createPick` — no game resolution there today, and no `pickedSide` either), and
any bulk import where the game didn't resolve to live odds keep
`mlFavoredSide = null` and fall back to the odds-sign heuristic. Historical
favorite/underdog moneyline stats on Dashboard / Reports / Cappers / Sharp Money
therefore stay **exactly as inconsistent as they are today — not worse**. New
picks going forward are correct; the mix of correct and heuristic-classified
picks improves steadily as new picks accrue.

---

## 5. If a backfill is wanted later (not in scope)

A one-time backfill of `Pick.mlFavoredSide` for historical rows:

- **Decided picks:** join to `GameResult.favTeam` (already captured for grading,
  when odds could be matched) and compare it to the picked team.
- **Pending picks / rows with no `GameResult` match:** join to `OddsSnapshot`
  for that game/date, same as `recomputeTeamTendencies` does.
- Rows with no odds data available anywhere stay `null`.

That is a schema-free data migration + a stat cache invalidation; decide
priority against the impact numbers from the read-only analysis query before
committing to it.
