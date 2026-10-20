# Parlay Generator follow-ups

Deferred work from the generator consolidation (PRs 1-7, started 2026-10-19).
Logged here so it isn't lost; none of it is built yet.

- **Send to FanDuel on a slip over 25 legs** should say "25 legs max" instead of
  "Couldn't check FanDuel right now". Whole-slip Send to FanDuel sends every slip
  pick; `/api/parlay/fanduel-link` refuses more than `MAX_PARLAY_LEGS` with a 400,
  and `send-to-fanduel.tsx` shows the generic failure. Only reachable with a slip
  saved before the cap existed. (Logged 2026-10-19.)
- **Zero-reads acceptance test is DB-only and SKIPs in CI**; revisit when CI gets a
  database (`parlay-generate-zero-reads-acceptance-test.ts`; the pure
  `generator-session-acceptance-test.ts` covers the reuse/reload rules in CI).
  (Logged 2026-10-19.)

## From PR 7 (Live slip mode, #299)

- **Game page (`/live/[gameId]`) is only half in slip mode.** Its pick cards show the
  slip checkboxes (it reuses `GamePicksExpander`), but it has no "Target game"
  checkbox and no slip-mode bar (Exit / Send to generator). Add both, or hide the
  checkboxes there. (Logged 2026-10-20.)
- **A refused target says nothing.** `toggleTarget` refuses past 100 targets (the
  action's request bound) and returns false; the checkbox just doesn't tick. Show
  a message like the "25 legs max" one for picks. Unreachable in practice.
- **Feed's "Target game" label** uses the first pick's short `gameLabel`, or the full
  team names on a card with no picks, so the same game can read two ways in the
  generator's chips. Build it from the short names (`shortTeamName`) everywhere.
- **Old engine code still in the tree:** `lib/parlay/alternates.ts` (`buildParlaySet`,
  `lockParlay`), `slip-build.ts`, `pool-swap.ts`'s `buildPoolPrimary`, and
  `auto-generate.ts`'s `buildAutoParlay` / same-game fill. Nothing in the app calls
  them now; they're only imported by their own tests and by the egress-guarded
  `board-odds-projection-parity` and `board-picks-window-parity` tests. Delete them
  once those two tests are moved onto `generator.ts` (needs the egress owner's OK).
- **Your Picks' records cost a read per slip change.** `/parlay` still calls
  `getLeagueRecordsAction` whenever the slip's picks change, to show W-L before a
  Generate. After a Generate the same records are in the snapshot; Your Picks could
  read them from there and only call the action before the first build.
