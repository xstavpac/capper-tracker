# Postponed / cancelled games: follow-ups

Companion to `grading-match-audit.sql`.

## Repair needed (audit results, prod, 2026-10-20)

The audit (blocks A-E of `grading-match-audit.sql`) was run in prod. Nothing
below is repaired by the fix PR; the fix only stops new phantom rows and
moves `gameDate` for a makeup the score feed still lists.

- **GameResult 849817** (ALCS TB @ CLE): `gameDate` is still the postponed
  slot, 2026-10-17 00:00 UTC, with the makeup's 3-1 score. Set it to
  **2026-10-18 21:08 UTC**, the makeup's start.
- **GameResult 824785** (TOR @ BAL): same bug. `gameDate` is still the
  postponed slot, 2026-09-22 22:35 UTC, with the makeup's 2-4 score. Set it to
  **2026-09-23 17:35 UTC**, the makeup's start per StatsAPI. No picks are
  affected.
- **22 picks graded off the 849817 phantom 0-0** (gameTime in the 10/17 00:00
  slot): 21 graded 2026-10-17 01:30 UTC and the NRFI at 22:30 UTC.
  - 16 moneyline: PUSH
  - Nick Martinez Under 12.5 Outs: PUSH
  - 2x Over 6.5: LOSS
  - 2x Under 6.5: WIN
  - NRFI: WIN

  Decision pending: void, or regrade against the makeup (TB 3-1).
- **3 F5 picks in the same slot**, graded 2026-10-19 00:30 UTC: after the
  makeup final, so off the makeup's real first-five score, but filed on the
  postponed slot. Decide alongside the 22.
- **6 stuck picks** (created 2026-10-18 for the makeup, gameTime 10/18 21:08):
  these should grade on the next cron run once 849817's `gameDate` is fixed.
  Confirm after the repair.

Checked and needing no repair:
- **823490** (BAL @ NYY, cancelled): its one phantom 0-0 row graded no picks.
- **ESPN-fed leagues**: no phantom rows.
- **The 7th pick**, "Guardians vs. Rays +0.5" (created 2026-10-19 22:51):
  Game 6 is correct.
- **Parlay legs**: only 4 graded legs in prod, none flagged.

Out of scope here: the older C flags (38 MLB `multi_exact`, 24 NCAAF
`drift_gt_1h`, the 2026-08-07 `no_exact` cluster, and 3 NCAAF
`reversed_close` on 9/19). Out of scope for the postponed-game
grading fix: that PR stops postponed and cancelled games from being written
as 0-0 finals, moves a replayed MLB gamePk's `gameDate`, and adds the
`postponed` / `cancelled` feed statuses. Each item below needs its own decision.

## 1. Pick ledger shows "Awaiting result" on postponed/cancelled games

`pickPhase` (`src/lib/pick-display.ts`) reads only `final` and `live` from the
feed status. A pick whose game is `postponed` or `cancelled` falls through to
the time-based phase and shows "Awaiting result" once the start time passes.
The ledger should show the game's status ("Postponed" / "Cancelled", via
`unplayedLabel` in `src/lib/feed-game-status.ts`).

## 2. Picks on ESPN-fed postponed games stay pending forever

ESPN gives a makeup game a new event id; MLB reuses the gamePk. For NFL,
NCAAF, NBA, WNBA and NHL, a pick stored at the postponed slot's time never
matches the makeup: it's a different GameResult row, usually more than a day
away, and `MAX_GAME_TIME_DRIFT_MS` (6h) blocks it. The pick stays PENDING. The
2025-26 scan found 6 such games: NBA 401810384 MIA @ CHI and 3 others, WNBA
401857072 NY @ DAL, NHL 401803179 LA @ CBJ.

Decision needed: **void** these picks, or **re-attach** them to the makeup
(update the pick's `gameTime` to the makeup's start, the way a book would
grade a bet carried over to the makeup). Either way, not by widening the
drift window.

## 3. Picks on cancelled games: void/push handling

A cancelled game (MLB `codedGameState` C, ESPN `STATUS_CANCELED`) is never
played, so no GameResult is ever written for it, and its picks stay PENDING.
Decide how they settle: CANCELLED status (no result), or graded as a push.
This also needs a trigger, since no final ever arrives to start grading.
There were 4 MLB cancellations in 2026; the ESPN scan window had none.

## 4. Worktree test env: DATABASE_URL not read from the worktree's .env

In a fresh worktree with the git-ignored `.env` and `.env.local` copied in,
DB-backed tests failed with `Environment variable not found: DATABASE_URL`.
The tests run as `node --require ./scripts/server-only-stub.cjs --import tsx`.
Stripping a UTF-8 BOM from the copied `.env` didn't fix it. Exporting
`DATABASE_URL` / `DIRECT_URL` into the shell did. `prisma migrate status`
(the CLI) read the same file fine. Fold this into the per-window test
database follow-up, so each window gets its own working test DB config
instead of exporting URLs by hand.
