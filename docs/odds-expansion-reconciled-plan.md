# Odds API Market Expansion — Reconciled Plan

**Status:** Canonical scope document. Supersedes the whitepaper and
`docs/sports-props-expansion-plan.md` (2026-09-03) for this initiative. No
code has been written against this plan. The build prompt is a separate,
later step.

**Date:** 2026-09-11

**Sources reconciled:**
1. "Odds API Market Expansion & Centralized Polling Specification v1.0" (the
   whitepaper) — full-game/period/prop market expansion across 7 sports,
   centralized polling, credit monitoring, market-priority fallback.
2. `docs/sports-props-expansion-plan.md` — an internal planning doc covering
   ~80% of the same ground, independently produced 2026-09-03, with real
   credit modeling and a 12-league scope.

Every factual claim below was checked against the current codebase directly
(grep/read, not assumption) — this document does not take either source's
word over the other where they conflict. Where a conflict is resolved, the
resolution and its evidence are stated explicitly.

---

## 1. Credit budget — LOCKED at 20,000 credits/month ($30 tier)

This is now final. Do not revisit.

The internal planning doc modeled the $30/20,000-credit tier against a
**richer polling cadence** than this initiative actually calls for (hourly
polling during active game windows, plus a 3-poll/day pre-game prop cadence)
and found it would run at **~73% of cap at peak month (April), with no
safety margin for estimate error.** It recommended the $59/100,000-credit
tier instead.

That modeling is not wrong, but it modeled the wrong cadence. This plan's
actual centralized-polling design (Section 3 below) is far leaner —
approximately two snapshots/day, event-driven per sport, no polling once a
game starts. Whether 20,000 credits/month is comfortable, tight, or
insufficient **under this leaner cadence has not been measured**, and per
the whitepaper's own instruction ("do not assume 20K is guaranteed to be
sufficient — measure actual consumption"), it will not be assumed here
either.

**Consequence: because the one credible model on record for this scope shows
a tier this tight running with no margin, Sections 30–32 of the whitepaper
(usage tracking, 70/85/95% warning thresholds, market-priority fallback) are
not an optional hardening pass to add later. They are required from the
initial build, in the same PR that starts requesting any new markets.**
Shipping expanded market requests without them risks silently burning the
monthly allowance before anyone notices — exactly the failure mode Section
31 exists to prevent, and the one credible cost model available says that
failure mode is a real risk at this budget, not a theoretical one.

## 2. What already exists — do not re-scope this

Verified directly against the codebase (`prisma/schema.prisma`,
`src/server/data/odds.ts`, `src/lib/parse-catalog.ts`, `src/lib/bet-line.ts`)
on 2026-09-11:

- **Period markets are built, not a gap.** `Period` enum
  (`prisma/schema.prisma:60-71`: `FULL_GAME, FIRST_HALF, SECOND_HALF,
  FIRST_QUARTER…FOURTH_QUARTER, FIRST_PERIOD…THIRD_PERIOD`) plus
  `Pick.period` are already wired into grading, `pickCategory`, the bet-type
  filter, and parlay legs (added commit `cdef254`, Sep 6 2026). The catalog
  parser's `pickPeriodFromText` (`src/lib/bet-line.ts`) already recognizes
  1Q–4Q, 1H/2H, NHL 1P–3P, and F5 phrasing.
  - **One subtlety worth knowing before building on this:** there is no
    separate `F5` enum value. The schema comment at
    `prisma/schema.prisma:62` states `FIRST_HALF` is deliberately overloaded
    — `"F5" in baseball terms, first half elsewhere`. MLB First-5 picks are
    stored as `FIRST_HALF`. This is intentional and already working, but any
    new code touching period logic should know `FIRST_HALF` means two
    different things depending on sport rather than assuming a dedicated F5
    value exists.
- **DB schema needs no new tables/columns for period or full-game market
  storage.** `OddsSnapshot` stores raw `OddsGame[]` as an untyped JSON blob
  — it can already hold any Odds API market key, including period and F5
  markets, once the fetch code requests them. `GameResult` uses
  sport-specific nullable JSON columns (`inningsJson`, `quartersJson`,
  `scoringPlaysJson`) for period data; a new sport needing period data
  follows that precedent, not a new mechanism.
- **`BetType` enum already has `PLAYER_PROP`**
  (`prisma/schema.prisma:34-41`: `SPREAD, MONEYLINE, TOTAL, TEAM_TOTAL,
  PLAYER_PROP, NRFI`). No new enum value is needed to represent "this pick is
  a player prop." What's missing is everything downstream of that value —
  see Section 4.
- **NHL full-game + period grading is genuinely done, just dormant.**
  `RESOLVABLE_SPORT_KEYS` (`src/server/data/odds.ts:744-757`) already
  includes `icehockey_nhl`; full-game grading needs no NHL-specific code, and
  P1–3 period grading is wired via `getEspnGameSegments` +
  `GameResult.linescoreJson`, with an acceptance test on record. It is inert
  only because `SPORT_SEASON_CONFIG`'s NHL window starts 2026-10-07
  (`src/lib/sport-seasons.ts:59`) and `dispatchLiveScoresForSport` returns
  `[]` before then. This is the intended "build disabled, enable later"
  pattern working as designed, not a gap to close.
- **Odds API credit headers are already read, just not persisted.**
  `readOddsApiCredits` (`src/server/data/odds.ts:119`) parses
  `x-requests-remaining` / `x-requests-used` on every response and logs a
  warning under a low watermark. There is no DB table and no admin-visible
  summary — see Section 6.

## 3. Corrected claim: NFL/NBA player props are NOT live today

The internal planning doc's current-state table marks NFL and NBA player
props "✅ (today)." This is stale/inaccurate. Verified directly: `grep` of
`src/server/data/odds.ts` for event-level odds calls (`/events/{id}/odds`)
and any player-prop market key (`player_points`, `player_pass_tds`, etc.)
returns zero matches. `ODDS_MARKET_PARAMS` is hardcoded to
`h2h,spreads,totals` only — full-game markets, no periods, no props, no
event-level requests, for any sport. Treat the internal doc's per-league
status table as partially aspirational; every "today" claim in it should be
grep-verified before being relied on again, the same way this one was.

The only real prop-adjacent code that exists today is `getNflPlayerTdStats`
(`src/server/data/odds.ts:1055-1086`), which parses NFL rushing/receiving TD
counts from ESPN's boxscore for Anytime TD grading — narrow, NFL-only, and
not connected to any Odds API prop-market ingestion. See Section 5.

## 4. The real hard lift: player-prop schema

Both source documents undersell this. The `PLAYER_PROP` `BetType` value
exists, but today it means "touchdown prop" exclusively:

- `parseTouchdownProp` in `src/lib/parse-catalog.ts` is the only prop parser;
  a comment in that file states outright this app doesn't support non-TD
  player props today.
- Grading hardcodes `gradeTouchdownProp` as the sole `PLAYER_PROP` grading
  path.
- `stats.ts`'s `pickCategory()` collapses every `PLAYER_PROP` pick into one
  category, `"TD_PROP"`, regardless of actual market — a non-NFL or
  non-TD prop pick categorizes as `TD_PROP` and simply never resolves
  (explicit comment on that line).
- **There is no `playerName` column and no prop-market sub-type column on
  `Pick`.** The prop subject and stat type live only in free-text
  `betDetail`. Distinguishing "Josh Allen Over 1.5 Passing TDs" from "Josh
  Allen Over 275.5 Passing Yards" from "Josh Allen Anytime TD" at the data
  layer — required for grading any of them correctly, and required by the
  whitepaper's own Section 10 (passing TD must never be confused with
  anytime TD) — needs a genuine schema addition: a `playerName` field and a
  prop-market discriminator, following the `Team Total` precedent's shape
  (enum/column + migration), not just adding phrasing to the parser.

This schema addition is a prerequisite for any prop beyond touchdowns being
gradeable at all, regardless of which sport's odds get ingested first.

## 5. Build order

Based on the grading-feasibility investigation (verified per-sport against
actual data sources, not assumed):

1. **NFL prop-grading extension.** Widen the existing ESPN boxscore parsing
   (`getNflPlayerTdStats` and its underlying `boxscore.players` structure) to
   extract the passing category alongside the rushing/receiving categories
   already read. Add `player_pass_tds` (whitepaper §7, REQUIRED) plus
   passing/rushing/receiving yards, attempts, completions, and receptions.
   This is the closest to shippable — the data source is already integrated
   and confirmed per-athlete; only the parsing coverage is narrow today.
2. **MLB verification pass.** Confirm whether MLB Stats API's
   `feed/live` endpoint — already in use by `getMlbEarlyInningScores` for
   linescore data — also carries `liveData.boxscore.teams.{home,away}.players`
   with per-player batting (hits, HR, RBI, total bases) and pitching (K, BB,
   outs) in the shape documented for that public API. This codebase has
   never fetched or verified that shape live; it's a verification task
   against an endpoint already integrated, not a new integration.
3. **`playerName` + prop-market sub-type schema addition** (Section 4). The
   actual hard lift, and a hard prerequisite: no prop beyond touchdowns is
   gradeable — for any sport — until this lands, so it must be done before
   step 1 or 2's parsing work is useful beyond TDs, and before step 6 (NBA)
   is worth starting at all.
4. **Period-market odds ingestion.** Cheap relative to props — the schema,
   `Period` enum, and catalog period-detection are already built (Section
   2); this step is primarily widening `ODDS_MARKET_PARAMS` / adding
   event-level requests for period market keys, sport by sport, and
   verifying the Odds API's actual current key names (whitepaper §6: "use
   the exact current Odds API market keys, do not invent market keys" — the
   internal doc's §2b table lists keys it confirmed live against the
   provider's docs; use those as the verified starting point, re-confirm
   before use since API market keys can change).
5. **UI touchpoint work.** `stats.ts`'s `pickCategory()`/`CHIP_SET_BY_SPORT`
   fan-out and the separate, deliberately-uncoupled
   `bet-type-filter.ts`/`sport-bet-type-filter.tsx` fan-out both need one
   new category/filter-option increment per newly-gradeable market — roughly
   20 increments across both places at full target scope. No component-level
   hardcoding blocks this (both are array/map-driven), but it is real,
   repetitive logic work, not a config change.
6. **NBA.** Deferred until step 3 is done (props ungradeable without it
   regardless) and until a per-player boxscore/summary data source is
   identified and integrated — none exists in the codebase today; only
   team-level final score (`getEspnScores`) is fetched for NBA currently.
7. **NHL.** Lowest priority by default — not because it's hard, but because
   it's moot until the season window opens 2026-10-07 (`SPORT_SEASON_CONFIG`,
   Section 2) regardless of build sequencing, and because, like NBA, no
   per-player boxscore source is integrated yet for NHL prop grading. Full
   game + period grading for NHL is already done (Section 2) and needs no
   further work in this initiative.

Sequencing rationale: steps 1–2 make the closest-to-real capability
(NFL/MLB props) actually gradeable soonest; step 3 unblocks every sport
beyond TD props and must land before further prop parsing work compounds on
a data model that can't distinguish markets; step 4 is picked up in parallel
since it doesn't depend on the prop schema at all; steps 5 onward are
UI/new-sport work that's only worth doing once the underlying grading path
exists.

**Out of scope for this initiative, not forgotten:** the internal planning
doc's other 6 leagues (CFL, KBO, NCAAB, ATP, WTA, UFC/MMA) describe a
separate, still-open scope item with its own season-window and score-source
research needs (documented in that file's Section 6, "Known gaps"). Nothing
in this reconciliation changes that doc's findings for those leagues; they
simply aren't part of the player-prop-and-period expansion this plan covers.

## 6. Admin manual "refresh odds now" switch

**Admin account is explicit and singular:** `xstavpac@gmail.com` is the
administrator for this feature. This is a one-person gate, not a role
system — do not build a general admin-role table or a multi-admin
permission system for this.

1. **Gating mechanism.** Use a simple session-email check — compare the
   signed-in user's email against `xstavpac@gmail.com`, either hardcoded or
   via an `ADMIN_EMAIL` environment variable set to that address — directly
   in the route/page. **Do not reuse the Zone Model feature-flag pattern**
   (`feature_flags` + `feature_flag_user_overrides` tables, seeded via
   migration — see `prisma/migrations/20260909130000_add_zone_model_second_admin_override`).
   That mechanism exists for a feature with a future "flip on for everyone"
   rollout path; a refresh button will never roll out beyond this one
   account, so the flag-table machinery would be pure overhead for a
   permanently single-admin check.
2. **Concurrency lock is required before exposing this on-demand.** The
   existing `refresh-odds` cron route calls `getOddsForSportUncached`
   directly, bypassing the in-memory TTL cache by design (comment: "the cron
   is the authoritative daily attempt, not a cache consumer"). There is no
   locking or idempotency guard anywhere in that path today. A manual
   trigger firing while the scheduled cron is also running, or a double
   click, would both make independent real Odds API calls and both write to
   the same `OddsSnapshot` row — last-write-wins, no data corruption, but
   duplicate, undeduped credit spend. A short-lived lock (DB row or
   equivalent, keyed on date/sport) must be added before this route is safe
   to trigger on demand.
3. **Cost confirmation + cooldown are both warranted**, consistent with
   Section 1's "no optional extras" stance on credit safety. One manual
   click is functionally a full unscheduled snapshot across every polled
   sport — a meaningful single-digit percentage of a 20,000-credit monthly
   budget in one click. Require: (a) a confirmation step showing an
   estimated credit cost before firing, and (b) a cooldown (button disabled
   for roughly 15–30 minutes after use) to prevent repeated clicks from
   compounding a spike.
4. **Where it lives.** There is no existing admin panel anywhere in the app
   today — `src/app/(app)/settings/page.tsx` is the only settings surface,
   and it's fully user-facing (`requireUser()`-gated, not admin-gated). This
   button is the first admin-only surface in the app. A small dedicated
   admin page/route is the cleaner precedent to set versus a conditionally
   rendered block bolted onto user Settings, though that's a build-time
   choice, not something this reconciliation needs to decide.

## 7. Summary of resolved conflicts

| Conflict | Resolution | Evidence |
|---|---|---|
| Whitepaper targets 20,000 credits/month; internal doc recommends $59/100,000 | **20,000/month is locked.** The doc's rejection of that tier assumed a heavier cadence than this plan's leaner centralized-polling design uses; actual consumption under the real cadence is unmeasured, not assumed safe or unsafe. | Whitepaper §3; internal doc §3 (73% peak under hourly-window modeling); this plan §1 |
| Internal doc: NFL/NBA player props "✅ (today)" | **False.** No event-level odds calls or player-prop market keys exist anywhere in `odds.ts`. | Direct grep, 2026-09-11, this plan §3 |
| Whether period markets need new schema | **No — already built and wired.** | `prisma/schema.prisma:60-71`, commit `cdef254`; this plan §2 |
| Whether `PLAYER_PROP` needs a new enum value | **No** — the value exists; what's missing is the `playerName`/prop-market columns and the grading/parsing/category logic behind it. | `prisma/schema.prisma:34-41`; `parse-catalog.ts`; `stats.ts`; this plan §4 |
| NHL grading status | **Already fully built** (full game + P1-P3), inert only pending the 2026-10-07 season window — internal doc's claim here checked out. | `odds.ts:744-757`, `sport-seasons.ts:59` |
| Whitepaper's NFL prop market list (10 markets incl. separate rushing/receiving TDs) vs. internal doc's locked list (6 markets) | **Not resolved by this document** — re-verify the internal doc's confirmed key names against the live Odds API before finalizing the NFL prop list in step 1 of the build order; do not invent keys per whitepaper §6. | Whitepaper §7-11; internal doc §2b |
