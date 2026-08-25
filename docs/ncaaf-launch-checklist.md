# NCAAF launch checklist — verify the pipeline on a real finished game

Context: NCAAF category tiles (`NCAAF_CHIP_SET` in `src/server/data/stats.ts`) and
first-half grading (`getNcaafFirstHalfScore` in `src/server/data/odds.ts`) were
built and code-reviewed before the 2026 season had produced a single finished
game. Everything was verified against real *historical* ESPN data (2025-season
games, including one that went to overtime) and against the real, live-cached
`OddsSnapshot`/`GameResult` tables, but the full real-time pipeline — a 2026
game finishing, ESPN reporting it, the cron picking it up, a pick grading, a
tile updating — has never run end to end. This is the checklist to close that
gap the first time a real NCAAF game finishes (FBS Week 0 starts 2026-08-29).

Run the `prisma.*` snippets below with `npx tsx` against a small script (see
the pattern used throughout this investigation - manually load `.env` first
since `tsx` doesn't auto-load it the way `next dev` does).

## 1. ESPN reported it final

Hit the same public endpoint the app uses and confirm the game you're
checking has `status.type.state === "post"`:

```
https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard
```

## 2. `GameResult` got the final score

Should happen within ~15 minutes via the `grade-picks` cron (calls
`persistFinalScores` for every `RESOLVABLE_SPORT_KEYS` sport, NCAAF
included). There's also a once-daily `refresh-scores` cron as a backup net
if that's ever missed.

```ts
prisma.gameResult.findFirst({
  where: { sportKey: "americanfootball_ncaaf" },
  orderBy: { createdAt: "desc" },
});
```

Confirm `homeScore`/`awayScore` match the real final score.

## 3. The new part — first-half score actually came from ESPN

This is the specific thing built this session, so it's the one most worth
checking directly rather than assuming it rode along with #2:

```ts
// same row as #2
firstFiveHomeScore, firstFiveAwayScore
```

These should be non-null and equal Q1+Q2 of that game's real box score
(cross-check against the ESPN summary endpoint's `linescores`:
`https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=<id>`,
same way this was verified against Ohio State/Penn State and a real
overtime game during development). If they're `null`, `getNcaafFirstHalfScore`
failed silently for this game — worth knowing, not assuming.

## 4. A real pick graded

If any capper has a real NCAAF pick logged against that game:

```ts
prisma.pick.findMany({
  where: { sport: { name: "NCAAF" } },
  include: { sport: true },
});
```

Confirm `status` moved from `PENDING` to `WIN`/`LOSS`/`PUSH`. If any of
those picks have `period: "FIRST_HALF"`, that's the one that specifically
proves the new fetcher paid off — a full-game pick grading correctly was
never in doubt (that path is untouched by this work), a first-half pick
grading correctly is the new thing.

## 5. Tiles show up and match

Open `/live?sport=americanfootball_ncaaf`. The "NCAAF record by category"
panel should now render (it doesn't yet — as of this checklist being
written, there are zero NCAAF picks of any status in the database, so the
panel has nothing to show and doesn't appear at all). Cross-check the tile
counts against a manual count of step 4's decided picks by category.

## 6. TD Prop tile should NOT appear for NCAAF

Worth a quick negative check — `NCAAF_CHIP_SET` deliberately omits `TD_PROP`
(touchdown-prop grading, `resolveTouchdownProp` in `src/server/data/grading.ts`,
stays NFL-only by design). Confirms that omission held, not an accidental gap.
