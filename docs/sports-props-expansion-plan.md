# Sports & Player-Props Expansion — Planning Document

**Status:** Planning artifact. No code has been written. Scope and the odds-API
plan decision are **decided**; build order and score-source research are
**open**.

**Date:** 2026-09-03

**Provider under discussion:** `the-odds-api.com` (v4, `api.the-odds-api.com`).
Not to be confused with `theoddsapi.com` (a separate, newer vendor) — the
codebase calls the hyphenated one and this document is about that one.

---

## 1. Executive summary

### What we're building

An expansion of Capper Tracker's odds and grading coverage from 5 sports to a
locked set of 12 leagues, plus player-prop support for 4 of them.

### Current state (today)

- **5 fully resolvable leagues** (odds + live scores + grading): **MLB, NBA,
  WNBA, NFL, NCAAF**
- **1 odds-only league** (odds polled and displayed, no grading yet): **NHL**
- **Target:** **12 total leagues, 4 of them with player props**

The 5 resolvable leagues are the ones listed in `RESOLVABLE_SPORT_KEYS`
(`src/server/data/odds.ts`). NHL is in `LIVE_SPORTS` and `SPORT_SEASON_CONFIG`
but is **deliberately absent** from `RESOLVABLE_SPORT_KEYS`, so its odds flow and
display but nothing attempts to resolve or grade an NHL pick.

| League | Odds | Live scores | Grading | Player props |
| --- | --- | --- | --- | --- |
| MLB | ✅ | ✅ | ✅ | ❌ (planned) |
| NBA | ✅ | ✅ | ✅ | ✅ |
| WNBA | ✅ | ✅ | ✅ | ❌ (not in scope) |
| NFL | ✅ | ✅ | ✅ | ✅ |
| NCAAF | ✅ | ✅ | ✅ | ❌ (not in scope) |
| NHL | ✅ | ❌ | ❌ | ❌ (planned) |

### Target end state

| League | Game lines (ML / spread / total) | Player props |
| --- | --- | --- |
| MLB | ✅ (today) | ✅ **new** — 6 markets |
| NBA | ✅ (today) | ✅ (today) — 5 markets |
| NFL | ✅ (today) | ✅ (today) — 6 markets |
| NCAAF | ✅ (today) | — |
| WNBA | ✅ (today) | — |
| NHL | ✅ display today → **full grading** | ✅ **new** — 3 markets |
| CFL | **new** | — |
| KBO | **new** | — |
| NCAAB | **new** | — |
| ATP (tennis) | **new** — tournament-keyed, h2h only | — |
| WTA (tennis) | **new** — tournament-keyed, h2h only | — |
| UFC / MMA | **new** — h2h only (no prop data exists on this provider) | — (not available) |

### Why

- **Coverage is the product.** Per `VISION.md`, the long-term goal is a
  community-verified record of *who actually performs*. Cappers post props and
  non-major-league picks constantly; a pick the app can't grade is a hole in
  that record.
- **Props are "professional tools" territory.** `VISION.md`'s future tier
  ($9.99–14.99/mo) is defined around advanced analytics — prop tracking and
  grading is exactly that.
- **Infra stays lean.** The odds-API cost of the whole expansion (§3, §7) is
  ~$59/month at peak scope — well inside `VISION.md`'s "$100–500/month at
  1,000–5,000 users" envelope.

---

## 2. Final locked scope

### 2a. Game-line only (moneyline, spread, total) — no player props

Hourly polling **during realistic active windows only** (days the league plays,
hours around game/event time — not flat 24/7).

| League | Odds API key(s) | Notes |
| --- | --- | --- |
| **ATP** | `tennis_atp_*` (~22 tournament keys) | No single "ATP" key. Each tournament is its own key, `active: true` only during its ~1–2 week run. Poll **only currently-active keys**, discovered from the free `GET /v4/sports` list. **h2h only** — tennis has no meaningful spreads/totals on this provider. One `/odds` call returns the whole tournament draw for 1 credit (verified: 24 US Open matches, `x-requests-last: 1`). |
| **WTA** | `tennis_wta_*` (~40 tournament keys) | Identical structure and polling logic to ATP. `tennis_wta_us_open` was `active: true` at time of writing. |
| **CFL** | `americanfootball_cfl` | `active: true`, `has_outrights: false` → real h2h/spreads/totals. 2026 season: June 4 – Oct 24 regular season, playoffs to the 113th Grey Cup on **Nov 15, 2026**. ~4 games/week, Thu–Sun. |
| **WNBA** | `basketball_wnba` | **Already fully supported today** (in `RESOLVABLE_SPORT_KEYS` and `SPORT_SEASON_CONFIG`). Listed here only for completeness — no new work. Confirm its season-config dates are current for the next season before relying on them. |
| **KBO** | `baseball_kbo` | `active: true`. 2026 season: opens **March 28**, regular season ends unusually early (**Sept 6**), playoffs / Korean Series run into ~late October. Full 5-game daily slate confirmed live. ~5 games/day, 6 days/week (no Monday). Games fall in the ET overnight window. |
| **NCAAB** | `basketball_ncaab` | Carried but `active: false` off-season (0 events at time of writing). Season ~early Nov – early April (Final Four ~first week of April). Very high game volume on peak days, but game-line polling cost is per-poll not per-game, so this doesn't inflate cost. |
| **UFC / MMA** | `mma_mixed_martial_arts` | `active: true`, `has_outrights: false`. **h2h only.** Direct API test returned `422 INVALID_MARKET` for `method_of_victory`, `rounds`, `total_rounds`, `mma_method_of_victory` — MMA is not even listed in the provider's betting-markets documentation. ~1 card/week, ~10–14 fights/card; one `/odds` call returns every fight on every upcoming card for 1 credit (verified: 64 fights, `x-requests-last: 1`). |

### 2b. Full game-line + player props

Game lines as above (hourly / active-window). Props via the **per-event**
endpoint (`GET /v4/sports/{key}/events/{id}/odds`), billed **markets returned ×
regions**, at the established **3-poll pre-game cadence** (morning / midday /
near-lock) — **not hourly, no in-play polling**. Prop *results* are graded from
box scores, not from live prop odds.

| League | Prop markets (locked) | Count | Status |
| --- | --- | --- | --- |
| **NFL** | `player_pass_yds`, `player_pass_tds`, `player_rush_yds`, `player_reception_yds`, `player_receptions`, `player_anytime_td` | 6 | Existing scope — unchanged |
| **NBA** | `player_points`, `player_rebounds`, `player_assists`, `player_threes`, `player_points_rebounds_assists` | 5 | Existing scope — unchanged |
| **NHL** | `player_shots_on_goal`, `player_goals`, `player_points` | 3 | **New** |
| **MLB** | `batter_hits`, `batter_total_bases`, `batter_home_runs`, `batter_rbis`, `batter_runs_scored`, `pitcher_strikeouts` | 6 | **New** |

All four market sets were confirmed against the provider's betting-markets
documentation. NHL also offers `player_assists`, `player_blocked_shots`,
`player_power_play_points`, `player_total_saves`, and first/last/anytime goal
scorer; MLB offers ~14 batter and ~6 pitcher markets plus `_alternate` variants.
The locked lists above are a deliberate subset — expanding them later is a
scope-growth decision with a direct credit cost (§3).

### 2c. Explicitly NOT in scope

- WNBA / NCAAF / CFL / KBO / NCAAB / tennis player props.
- UFC props of any kind (no data on this provider — §6).
- Alternate-line markets (`*_alternate`) for any sport.
- In-play / live prop odds polling.
- Any second odds provider.

---

## 3. Odds API plan decision

### Decision

**Subscribe to `the-odds-api.com` at the $59/month tier (100,000 credits/month)
when live polling for the expanded scope begins.**

Not before — see §4.

### Reasoning

Credit model: `GET /odds` (bulk) costs `markets × regions` **specified**;
`GET /events` is free; `GET /events/{id}/odds` (per-event, used for props) costs
`markets × regions` **returned**. All game-line calls use
`markets=h2h,spreads,totals` × `regions=us` = 3 credits (tennis/MMA: h2h only =
1 credit).

Under the locked scope (§2), modelled against **verified 2026 season calendars**
and **realistic active-window polling** (not flat 24/7):

- **Peak month ≈ ~14,600 credits (April)** — MLB + NBA + NHL props all active,
  plus NBA/NHL/MLB/KBO game lines and the NCAAB tail.
- **Annual ≈ ~126,000 credits.**
- Full month-by-month table in §7.

| Plan | Peak month vs cap | May–Sept months vs cap | Assessment |
| --- | --- | --- | --- |
| **$59 / 100,000 per month** | **~15%** | 10–13% | ~6.5× headroom in the worst month. Prop-scope growth (more markets, a 4th prop league, tighter cadence) does not threaten it. **Chosen.** |
| $30 / 20,000 per month | **~73%** | 48–63% | Only ~1.35× buffer in April; the entire May–September stretch runs above half the cap. Any estimate error, added market, or cadence change breaks it. Rejected. |

MLB player props (~6,800 credits/month in-season, the single largest line item)
is what removes the $30 tier from contention. Without MLB props the $30 tier had
a safe ~2× buffer; with it, there is no margin for the estimate to be wrong.

`theoddsapi.com`'s $99 Business plan (200,000 requests/month) — the plan
originally raised — is a **different vendor**, would require a migration, and is
~7–13× oversized even at the April peak. Rejected.

### Verification basis

This estimate is **not** built on assumptions:

- Sport coverage (CFL, KBO, ATP, WTA, NCAAB, MMA) confirmed via a live
  `GET /v4/sports?all=true` call with the project key.
- Per-call credit cost confirmed empirically (`x-requests-last` header on real
  calls: NFL 5-market per-event = 5; ATP h2h bulk = 1; MMA h2h bulk = 1; empty
  MLB event = 0).
- UFC prop-market absence confirmed by `422 INVALID_MARKET` responses.
- 2026 season calendars (CFL, KBO) confirmed against league announcements; the
  others against standard published schedules.
- Current account state read live: the key in `.env` is on the **free 500-credit
  Starter plan** with 149 credits already used by Sept 3 (see §6).

---

## 4. Build sequencing — the "build disabled, enable later" pattern

**Infrastructure can and should be built and tested before any live polling
begins or the paid plan is purchased.** This is the same approach NCAAF took
this year (`docs/ncaaf-launch-checklist.md`): category tiles and first-half
grading were built, code-reviewed, and verified against historical data *before
the 2026 season produced a single finished game*.

Two existing gating mechanisms make "built but dormant" cost nothing:

### `SPORT_SEASON_CONFIG` / `isSportInSeason` (`src/lib/sport-seasons.ts`)

Gates whether a sport's odds are fetched **at all**. `getOddsForSport` and
`backfillOddsForSport` both call `isSportInSeason` first and return `[]` before
any DB read or network call if it's false. `isSportInSeason` **fails closed** —
a `sportKey` with no `SPORT_SEASON_CONFIG` entry is treated as out of season
forever.

→ A new league with code written but **no `SPORT_SEASON_CONFIG` entry** is never
polled. Zero credit cost.

### `RESOLVABLE_SPORT_KEYS` (`src/server/data/odds.ts`)

Gates whether grading runs for a sport. The `grade-picks` and `refresh-scores`
crons both iterate `RESOLVABLE_SPORT_KEYS`; `persistFinalScores`,
`gradeAllPendingPicks`, tendency recompute, etc. only touch listed sports.

→ A new league **not in `RESOLVABLE_SPORT_KEYS`** has no grading attempts, no
score-fetch calls, no cron time spent on it — even if its odds are being polled
and displayed (this is exactly NHL's status today).

### The pattern

For each new league:

1. Build parser support, ingestion, grading logic, tests — all of it.
2. Land it with the league **absent from both** `SPORT_SEASON_CONFIG` and
   `RESOLVABLE_SPORT_KEYS`.
3. Verify against historical / cached data (the NCAAF playbook).
4. When ready to go live: purchase the plan, add the `SPORT_SEASON_CONFIG`
   entry (odds start flowing), then add to `RESOLVABLE_SPORT_KEYS` (grading
   starts). These two switches can even be staged apart — odds-display-only
   first, grading once a score source is proven.

Until step 4, the build has **zero ongoing cost**.

### Launch gate — Definition of Done per league

The ordered conditions to move a league from **dormant** (built, disabled) to
**live**. Each is a hard gate: a league does not advance to the next step until
the current one is met. Run this checklist per league.

1. **Odds parsing verified against a live provider response** — the league's
   key(s) fetch, and the payload parses into `OddsGame`s with the expected
   markets.
2. **Catalog / entity resolution verified** — team or player names taken from
   real capper pick text resolve to the right entity (including any
   cross-league name collisions).
3. **Score / result source verified** — a real finished event for that league
   is fetchable, correctly shaped, and includes any period/box-score data the
   grading needs.
4. **Historical grading acceptance tests pass** — picks graded against past
   finished events produce correct `WIN` / `LOSS` / `PUSH`, following the
   `*-acceptance-test.ts` convention.
5. **`SPORT_SEASON_CONFIG` enabled** — the season-window entry is added; odds
   polling for the league begins.
6. **Live polling monitored successfully** — real slates land in `OddsSnapshot`
   with no silent fetch failures, observed for at least a few days.
7. **`RESOLVABLE_SPORT_KEYS` enabled** — added **only after** grading is proven
   against live data (not just the historical tests in step 4). This is the
   switch that turns on resolution and grading for real user picks.
8. **Credit consumption confirmed against §7** — actual `x-requests-used` for
   the league is tracked over a full week and reconciled with this document's
   estimate; a material overrun is investigated before the next league is
   enabled.

---

## 5. Per-league build checklist

Derived from patterns already established in this codebase. "New league" =
CFL, KBO, ATP, WTA, NCAAB, UFC. "Props addition" = NHL props, MLB props.

### 5a. Common to every new league

| Area | What's needed | Reference pattern |
| --- | --- | --- |
| **Catalog parser** | Team/player name → canonical resolution. Nickname lists, city-qualified disambiguation entries where names collide with existing leagues. | `src/lib/parse-catalog.ts` — `DISAMBIGUATED_TEAMS`, `AMBIGUOUS_NICKNAMES`, and the bare-city routing added for "Shark – Boston Over 7.5" (Red Sox) and "Sharp Sheet – Ottawa +7.5" (CFL). NCAAF's full-FBS team set is the large-roster example. |
| **Odds ingestion** | Usually none beyond a `LIVE_SPORTS` entry — `getOddsForSport` / `backfillOddsForSport` are already generic over `sportKey`. Tennis/MMA need active-key discovery (filter `active: true` from `GET /v4/sports`) and h2h-only market params. | `src/server/data/odds.ts` — `getOddsForSportUncached`, `LIVE_SPORTS`. |
| **Score / result ingestion** | A source that reports final scores (and any period splits the grading needs). This is the hard part for several leagues — see §6. | ESPN scoreboard helper `getEspnScores(sportPath)` (NBA/WNBA/NFL/NCAAF share it); MLB Stats API for MLB; nflverse static CSVs for NFL team stats. |
| **Grading logic** | Wire the sport into `persistFinalScores` and the grade paths. Full-game ML/spread/total is generic; period markets (first half, etc.) need a sport-specific fetcher. | `src/server/data/grading.ts` — `gradePick`. First-half fetchers: `getNflGameFacts`, `getNcaafFirstHalfScore`, `getNbaFirstHalfScore`. |
| **`SPORT_SEASON_CONFIG` entry** | Season start/end (through postseason). Left out deliberately until go-live (§4). | `src/lib/sport-seasons.ts` |
| **`RESOLVABLE_SPORT_KEYS`** | Added only once a score source is proven. | `src/server/data/odds.ts` |
| **Tests** | Acceptance tests against real historical responses, following this session's convention (`npx tsx`, manual `.env` load). | `*-acceptance-test.ts` throughout `src/server/data/` |

### 5b. Per-league specifics

**CFL** — American-football-shaped, so ML/spread/total grading is closest to
NFL/NCAAF. Needs: a score source (ESPN carries CFL — confirm the
`site.api.espn.com/.../football/cfl` path shape matches `getEspnScores`), team
nickname list (9 teams; "Ottawa" city-collision already partially handled),
`SPORT_SEASON_CONFIG` (June–Nov). No period markets in initial scope.

**KBO** — Baseball-shaped. Needs: a score source (MLB Stats API does **not**
cover KBO — research required, §6), 10-team nickname list with city
disambiguation ("Doosan Bears" etc. — a `KBO_TEAMS` stub already exists in
`parse-catalog.ts`), `SPORT_SEASON_CONFIG` (late March – late October).
First-inning / F5 markets (NRFI, first-five) are MLB-only today and stay out of
KBO's initial scope unless the score source provides linescores.

**NCAAB** — Basketball-shaped, closest to NBA. ESPN carries it
(`.../basketball/mens-college-basketball`). Large team set (~360 D1), so the
catalog-parser work is the NCAAF-scale effort. `SPORT_SEASON_CONFIG` (Nov–April).
First-half grading would reuse the `getNbaFirstHalfScore` linescores approach
against the college summary endpoint.

**ATP / WTA (tennis)** — Structurally unlike every other league:

- Ingestion polls a *set of currently-active tournament keys*, not one fixed
  key. Needs a helper that lists `active: true` `tennis_atp_*` / `tennis_wta_*`
  keys from `GET /v4/sports` and polls each.
- Markets: **h2h only**. No spread/total.
- Entities are *players*, not teams — `homeTeam`/`awayTeam` carry player names.
  Catalog resolution is player-name matching (no nicknames, but transliteration
  and "first initial + surname" variants).
- Score source: research required (§6). ESPN has tennis coverage; suitability
  for match-result grading is unconfirmed.
- Grading is match-winner only — simpler than team sports once results are
  available. No period markets.

**UFC / MMA** — h2h only (method-of-victory / rounds / totals do not exist on
this provider, §6). Entities are fighters. Event cadence is ~1 card/week, each
card a cluster of individual fights sharing a date. Score source: research
required (§6) — needs fight results (winner, and ideally method/round for future
prop support). Grading is fight-winner only in scope.

### 5c. Props additions to already-supported sports

**NHL props (new)** — NHL game lines are already polled; NHL is *not* yet in
`RESOLVABLE_SPORT_KEYS`, so **full NHL game grading has to land first** (score
source, `persistFinalScores` wiring, `RESOLVABLE_SPORT_KEYS` entry) before props
grading is meaningful. Then: per-event prop ingestion for the 3 locked markets,
a box-score source for skater shots/goals/points (ESPN NHL boxscore or
NHL Stats API), and prop-grading logic. Follows the NFL TD-prop pattern
(`getNflPlayerTdStats`, `resolveTouchdownProp` in `grading.ts`).

**MLB props (new)** — MLB game grading already exists. Needs: per-event prop
ingestion for the 6 locked markets (3-poll pre-game cadence), a batter/pitcher
box-score source (MLB Stats API — `getMlbEarlyInningScores` already hits the
live-feed endpoint; the boxscore endpoint provides per-player hits/TB/HR/RBI/
runs and pitcher K), and prop-grading logic per market. This is the **largest
single credit line item** in the plan (§7) — the 3-poll × 6-market cadence is
worth revisiting if cost pressure appears (2 polls × 4 markets roughly halves
it).

### 5d. Cross-cutting

- **`BetType` enum** already has `PLAYER_PROP`. No new enum value needed for the
  prop markets; the specific market (points vs rebounds vs strikeouts) is
  carried in pick detail, resolved per the existing `PLAYER_PROP` grading paths.
- **`GameResult`** has sport-specific JSON columns (`inningsJson`,
  `quartersJson`, `scoringPlaysJson`). New sports needing period data would add
  their own nullable column following that precedent, not overload an existing
  one.
- **Parlay grading** (`parlay-grading.ts`) iterates the same sport keys — new
  leagues flow through once in `RESOLVABLE_SPORT_KEYS`.

---

## 6. Known gaps and open questions

### Confirmed gaps (decided facts)

- **No grading path exists today for CFL, KBO, ATP, WTA, NCAAB, or NHL.**
  - NHL: has odds display, needs a score source + `RESOLVABLE_SPORT_KEYS` entry.
  - CFL, NCAAB: ESPN almost certainly covers them; the `getEspnScores` path
    shape needs confirming per sport.
  - KBO: MLB Stats API does **not** cover it. A Korean baseball score source
    (KBO official, or a third party) needs research. Until then KBO can only be
    "odds display only."
  - ATP / WTA: match-result score source unconfirmed. Tennis result data is
    available (ESPN, others) but its fit for automated grading is unverified.
  - **These leagues cannot be more than "odds display only" until a real score
    source is identified and verified for each.**

- **UFC has no player/fight prop data on `the-odds-api.com`.** Verified via
  direct API test (`422 INVALID_MARKET` on `method_of_victory`, `rounds`,
  `total_rounds`). MMA is h2h-only on this provider. If UFC props (method of
  victory, round betting, total rounds) are ever wanted, that requires a
  **second odds provider** — SportsGameOdds and the enterprise tiers
  (OpticOdds / OddsJam) carry MMA props; coverage and cost would need their own
  investigation.

- **The `.env` key is on the free 500-credit tier** (149 used by Sept 3 —
  ~2,200/month pace, ~4× over the free cap). Before *or* independent of this
  expansion: confirm what `ODDS_API_KEY` production actually uses in Vercel. If
  it is this free key, `refresh-odds` / `backfill-odds` are silently 429-ing for
  ~3 weeks of every month (the code does `if (!res.ok) return`), which means the
  odds board goes stale and line-based grading falls back to a hardcoded −110.
  This is a possible standing bug, not part of the expansion.

### Open questions (not yet decided)

- **Build order / priority across the new leagues is not decided.** This
  document defines *scope*, not *sequence*. Plausible orderings include:
  "props first" (NHL + MLB props on already-supported sports, highest user
  value), "easy wins first" (CFL / NCAAB, likely ESPN-backed), or "by season
  calendar" (build what's next to come in season). To be decided separately.
- Whether NHL full grading is prerequisite to NHL props, or they ship together.
- Whether KBO / tennis / MMA launch as "odds display only" (no score source
  yet) or wait for grading — affects whether they're worth polling credits for
  at all before grading exists.
- Active-window polling cadence is modelled (§7) but not specified as a
  schedule. The current `vercel.json` crons (daily seed + 4-hourly backfill)
  are *not* hourly; moving to hourly-during-windows is its own implementation
  task with its own review.
- Prop market lists (§2b) are a locked *starting* subset. Expansion criteria
  (user demand? capper posting frequency?) not defined.

---

## 7. Cost summary — month-by-month credit estimate

Final estimate under the §2 locked scope. Game lines: hourly polling during
realistic active windows (game days only, ~game-time hours only), cost is
per-poll not per-game. Props: per-event, 3-poll pre-game cadence, billed on
markets returned.

| Month | Game lines | Props NFL/NBA/NHL | Props MLB | **Total** |
| --- | ---: | ---: | ---: | ---: |
| January | 3,565 | 5,665 | 0 | **9,230** |
| February | 3,010 | 5,365 | 0 | **8,375** |
| March | 3,215 | 5,265 | ~1,100 | **~9,580** |
| **April** | 3,905 | 3,900 | ~6,800 | **~14,600** |
| May | 3,930 | 1,900 | ~6,800 | **~12,630** |
| June | 3,845 | 500 | ~6,800 | **~11,145** |
| July | 2,820 | 0 | ~6,800 | **~9,620** |
| August | 3,000 | 700 | ~6,800 | **~10,500** |
| September | 3,445 | 1,240 | ~6,800 | **~11,485** |
| October | 4,450 | 3,740 | ~650 | **~8,840** |
| November | 3,855 | 6,505 | ~120 | **~10,480** |
| December | 2,775 | 6,505 | 0 | **~9,280** |

- **Peak month: April, ~14,600 credits** (~15% of the 100,000/month plan).
- **Annual: ~126,000 credits** (~10,500/month average).
- MLB props (~6,800/month in-season, Apr–Sep) is the largest single line item —
  larger than all game-line polling combined.
- UFC (~65/month) and each tennis tour (~390/month while touring) are rounding
  error at this scale.

For comparison, an earlier flat-24/7 hourly model (no active-window scoping) put
the peak at ~19,300 and annual at ~177,000 for a smaller sport list. Active-
window scoping cut the game-line portion ~70%; adding MLB props then added
~44,000/year back.

### Season windows used (verified)

| League | Active window |
| --- | --- |
| NFL | early Sept – early Feb (+ August preseason) |
| NBA | mid-Oct – mid-June (incl. playoffs) |
| NHL | early Oct – mid-June (incl. playoffs) |
| MLB | late March – early November (incl. postseason) |
| NCAAF | late Aug – mid-January |
| NCAAB | early November – early April |
| WNBA | mid-May – mid-October |
| CFL | June 4 – November 15 (2026, incl. Grey Cup) |
| KBO | March 28 – ~late October (2026; regular season ends Sept 6) |
| ATP / WTA | ~January – late November (per-tournament; Dec dormant) |
| UFC | year-round, ~1 card/week |

---

## Appendix — decided vs. open, at a glance

| Item | Status |
| --- | --- |
| The 12-league scope (§2) | **Decided** |
| The 4 prop-market sets (§2b) | **Decided** (as a starting subset) |
| Odds provider: `the-odds-api.com` | **Decided** |
| Plan: $59/mo, 100,000 credits | **Decided** |
| "Build disabled, enable later" approach (§4) | **Decided** |
| Per-league launch gate / Definition of Done (§4) | **Decided** |
| UFC props excluded (no data) | **Decided** (provider limitation) |
| Score sources for CFL/KBO/ATP/WTA/NCAAB | **Open** — research required |
| NHL full grading | **Open** — needs score source |
| Build order across leagues | **Open** — deliberately not sequenced here |
| Hourly-window polling schedule | **Open** — implementation task |
| When to purchase the plan | **Open** — after infra is built & tested (§4) |
