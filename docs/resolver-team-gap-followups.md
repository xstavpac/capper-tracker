# Resolver team-gap follow-ups

Open items from the "sport not tracked" grading-bug investigation
(BET LABS' "Fire over 165.5" pick mistagging as `ATP` instead of `WNBA`),
kept separate from `docs/ncaaf-launch-checklist.md` since neither is
NCAAF-specific.

## 1. Systemic guard against the ATP phantom-pick fallback - FIXED 2026-09

`findPlayerPick` (`src/lib/parse-catalog.ts`) used to accept **any** 1-4
Title-Case word candidate before a bet keyword as a confident `ATP` tennis
pick, purely because every other resolver had failed - "nothing else
matched" was treated as implicit confirmation. That is real, active data
corruption, not just a missed pick: the mystery line gets a Sport, a
capper, a `PENDING` status, and the raw bet text left in `homeTeam`, and it
can never grade or re-match. The two 2026-09-06 stuck picks
`"Mississippi -6.5"` (CBLEZ - Ole Miss / Miss State) and `"Red +1.5"`
(BET Sharper) were the trigger; `"Fire +13.5"` / `"Trojans -22.5"` /
`"KT Wiz ML"` were earlier instances.

**The fix** (implemented, not the "cross-check a DB team-name set" direction
originally proposed): `findPlayerPick` now requires **positive** tennis
evidence before it will accept a pick as `ATP`:

  1. the candidate surname (or full name) is in `KNOWN_TENNIS_PLAYERS` - a
     curated ATP + WTA list, keyed by surname, not exhaustive; or
  2. the line carries tennis-specific bet vocabulary (`TENNIS_BET_CONTEXT` -
     "straight sets", "games won", "tiebreak", "over N games", "double
     faults", ...); or
  3. an explicit `tennis` / `challenger` / `qualifying` word.

Plus hardened negative guards: `US_STATE_NAMES` (no tennis player is named
after a US state - catches "Mississippi") and `RECOGNIZED_TEAM_PHRASES`
(any bare team nickname / ambiguous key that somehow reaches here).

Anything with **no** tennis signal returns `null` and the line routes to
`unresolved` - exactly the safe, visible failure every other unrecognized
name already gets. From there the existing `recover-unresolved-picks` pass
(`live-team-fallback.ts`) still cross-checks it against the real live
schedule, so a genuine-but-unlisted team ("Mississippi") can still be
recovered as a real pick; only the silent tennis guess is gone.

Why not the DB cross-check: `parse-catalog.ts` stays pure/sync/DB-free, and
the recover-unresolved pass already owns the "check against real team
names" step - routing here to `unresolved` hands the line straight to it.

Deliberately NOT tightened: the name **shape** (real tennis picks are
commonly a bare surname - "Djokovic ML", "Sinner ML"). `KNOWN_TENNIS_PLAYERS`
grows the same way `SPORTS_PLACE_NAMES` did - add names as real picks on
unlisted players show up as `unresolved`.

### Residual: MMA fighters still route to `unresolved` (accepted)

A single-name MMA pick ("Jalin Turner Moneyline", from cappers like
"Thunder MMA") is not "X vs Y" so `findMatchupPlayerPick` (which resolves
`MMA`) doesn't catch it, and the fighter isn't in `KNOWN_TENNIS_PLAYERS`,
so it now routes to `unresolved` instead of a phantom `ATP` pick. That is
still the correct improvement (unresolved beats a wrong Sport), but a
proper `MMA` single-name path is a possible future follow-up.

## 2. Re-run the team-gap scan for NBA once preseason odds data exists

The 2026-08-25 audit cross-checked every real, currently-tracked team
(from `OddsSnapshot` + `GameResult`) against the resolver for MLB, NFL,
NHL, and WNBA - all clean now (see the `9be7c41` commit). **NBA had zero
real team names in either table at the time** (no odds had been fetched
yet this off-season), so NBA was never actually verified - it's an
unknown, not a confirmed-clean sport, unlike the other four.

Once NBA preseason odds start flowing (populating real `OddsSnapshot` rows
for `basketball_nba`), re-run the same cross-check: pull every unique
`homeTeam`/`awayTeam` for that sport, run each through `parseCatalog`, and
confirm it resolves to `NBA` (or a correctly-handled ambiguous prompt, like
"Cavaliers" already does).

## 3. FCS-vs-FCS college games are absent from both NCAAF feeds (known gap, no action)

Confirmed 2026-08-29 against both live APIs: an all-FCS matchup (the trigger
case was Jackson State @ Tennessee State, a SWAC game) appears in **neither**
`getLiveScoresForSport("americanfootball_ncaaf")` (ESPN's
`football/college-football` scoreboard - checked across a full week range,
only the ~8 FBS/FBS-vs-FCS openers came back) **nor**
`getOddsForSport("americanfootball_ncaaf")` (The Odds API's
`americanfootball_ncaaf` `/events` list - FBS only). Both NCAAF sources are
FBS-scoped upstream.

Consequence: a capper pick on an all-FCS game can't be resolved to a real
game - it lands in `unresolved` / "add manually", same as any team not in
`NCAAF_SCHOOLS`. This is distinct from the curated-list gap (issue 1) and
from the widening done in the full-FBS commit - those are about the parser's
team list; this is about the score/odds feeds themselves not carrying the
game. No fix planned: it needs an FCS score source wired into
`getLiveScoresForSport`, and FCS isn't in scope.

The related wrong-game-attach risk (a pick matching a *different*, later game
for an FCS team that also plays an FBS team - e.g. Tennessee State @ Georgia,
Sept 5) is separately closed by `withinResolveWindow` in `odds.ts`
(`MAX_RESOLVE_DATE_DRIFT_DAYS`): a candidate more than 2 Eastern days from
the pick's import date is rejected, so the resolver returns "no match"
rather than silently attaching the far game.
