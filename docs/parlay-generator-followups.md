# Parlay Generator follow-ups

Deferred work from the generator consolidation (PRs 1-7, started 2026-10-19).
Logged here so it isn't lost; none of it is built yet.

- **Send to FanDuel on a slip over 25 legs** should say "25 legs max" instead of
  "Couldn't check FanDuel right now". Whole-slip Send to FanDuel sends every slip
  pick; `/api/parlay/fanduel-link` refuses more than `MAX_PARLAY_LEGS` with a 400,
  and `send-to-fanduel.tsx` shows the generic failure. Only reachable with a slip
  saved before the cap existed. (Logged 2026-10-19.)
