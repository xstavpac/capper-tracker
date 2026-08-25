# Resolver team-gap follow-ups

Two open items from the "sport not tracked" grading-bug investigation
(BET LABS' "Fire over 165.5" pick mistagging as `ATP` instead of `WNBA`),
kept separate from `docs/ncaaf-launch-checklist.md` since neither is
NCAAF-specific.

## 1. Systemic guard against the ATP phantom-pick fallback (not urgent)

Not built yet - full writeup lives as a code comment directly above
`looksLikeTeamAbbreviation` in `src/lib/parse-catalog.ts`, since that's
where the next person touching this logic will actually see it.

Short version: a real, currently-tracked team whose bare name doesn't
happen to collide with anything else (like Portland Fire, LA Sparks,
Toronto Tempo, or Utah Mammoth were until this session's fix) will
silently mistag as a confident `ATP` tennis pick instead of surfacing as
`unresolved`, if it's simply missing from that sport's team list. The four
teams above are fixed now, but the underlying failure mode - any *future*
missing team hitting the same false default - is still there by design.
Deprioritized because it only bites when a real team name is missing from
our lists, which is now cleaned up across MLB/WNBA/NHL (see below) as of
2026-08-25.

Proposed direction (see the code comment for full reasoning and the
tradeoff to avoid): cross-check the ATP candidate against real,
currently-tracked team names (`OddsSnapshot`/`GameResult`) before accepting
the match, instead of tightening the name-shape check - the latter would
break legitimate single-surname tennis picks ("Djokovic ML"). Real
architectural work since `parse-catalog.ts` is a pure, synchronous,
DB-free module today.

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
