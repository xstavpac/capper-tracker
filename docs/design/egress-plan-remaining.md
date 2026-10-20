# Egress plan: what's left (handoff)

What remains of the 2026-10-19 DB Monitor egress plan, written so another session can pick it up cold. Update it as items finish.

## Done
| PR | What | Merge |
|---|---|---|
| #297 | Cappers: roster and find-or-create scan read `id` + `name` | ebd0596 |
| #301 | /picks: 18-column select, no capper/sport/league includes, names joined from the roster | 44ddf1e |
| #302 | Roster caches: rows in the Data Cache (24h, one entry per league), refresh-rosters revalidates every committed league | df0b455 |
| #304 | /picks: date range clamped to its last 31 days | e868640 |

Open check from #302: the first real revalidation is the 10:45 UTC refresh-rosters run. Confirm on /admin/crons that it logged, and that prop grading and import recovery still read the roster.

## Working rules (from the user)
- One PR at a time, each on a fresh branch off `origin/main` in the `wt-egress-plan2` worktree. Other Claude windows share the repo and the local DB.
- Per PR: related tests plus `npx tsc --noEmit`, then one full suite (`npm test`) before merge.
- **Shared local DB:** ask the user for the all-clear before any DB-backed test or the full suite, and say when the run is finished so they can hand the DB to the next window.
- Run DB-backed tests the way `scripts/run-tests.mjs` does: `node --require ./scripts/server-only-stub.cjs --import tsx <file>`. A bare `npx tsx` fails on `server-only`.
- **Baseline:** only `decay-delta-predictions-acceptance-test` is skipped (manual-only). Any other failure, including a parity test, is real.
- **Merge rule:** green CI, one clean full suite, no placeholder text left in the PR body, squash merge, wait for the prod deployment READY (GitHub deployments, `environment=Production&sha=<merge sha>`), then push-notify the user.
- A visible change doesn't auto-merge: send the Vercel preview link and wait for the user's check.
- Proof standard: each PR has a test showing the output is unchanged (old read vs new read on the same seed).
- `sed -i` with a `#` delimiter breaks on PR numbers. Edit PR bodies with a file and `gh pr edit --body-file`.

## PR 4: tendency history batching (in progress)
**Problem:** `resolveTeamTendency` (`src/server/data/model-engine/resolver.ts`) runs one `team_tendency_snapshots` query per (event × team input). That's 2 per event: the favorite and underdog inputs of `decayDeltaModel`. Each call reads that team's whole snapshot history. DB Monitor "Tendency history (model)" showed 128 calls averaging 40 rows.
- Callers: `orchestrate.ts` `runModelDefinition` → `resolveVariable`, from both passes of `syncDecayDeltaPredictions` (`decay-delta-predictions.ts`): graded (`persistGradedDecayDeltaGames`, asOf = the game's date) and pregame (`persistPregameDecayDeltaGames`, asOf = now).
- Trigger: the refresh-scores cron (`src/app/api/cron/refresh-scores/route.ts:134`, MLB only). Don't edit that route. The cron / "Odds for tendencies" investigation is on hold.

**Plan:**
1. **Parity test first.** Seed snapshots for a test-only sportKey with gaps. For each (team, asOf) case, `resolveVariable` with and without the preloaded history must return identical results: before the first snapshot (not found), an exact date, between gaps, after the last snapshot. Also count queries.
2. **Commit A, batching.** One `team_tendency_snapshots` read per pass for every team the pass will resolve (home and away of the pending or unstarted games), grouped by team, ordered by `snapshotDate` ascending. It's passed down via `runModelDefinition` options to `EvaluationContext`. `findLatestAtOrBefore` stays the only "as of" decider. A team that wasn't preloaded falls back to the old per-team query.
3. **Commit B, the bound.** Per team, keep only rows in [the latest `snapshotDate` ≤ the earliest asOf key in the run, the latest asOf key in the run]. Older rows are always superseded, and later ones are never at or before any asOf, so `findLatestAtOrBefore` picks the same row. Update the comment in `resolver.ts`, which currently says there's deliberately no date filter, to explain why this bound can't change the chosen row.

**Scaling:**
- Before: events × 2 × days of history, so worse than linear over a season.
- After A: teams × days, linear in history.
- After B: about teams × (1 + the run's asOf span), flat.
- Flat in users and pick history throughout.

## Post-F/G batch (ops F and G have merged, so these are unblocked)
Run these one after another, each as its own PR under the same rules.
1. **Sport lookup memo.** `sport.findUnique({ where: { name } })` runs 4× per sport per 15-minute grade-picks run (DB Monitor: 1,728 calls of 1 row each, about 95 KB; the win is round trips). Sites: `grading.ts` (`gradeAllPendingPicks`, `regradeAllFuzzyMatchedPicks`) and `parlay-grading.ts` (`gradeAllPendingLegs`, `regradeAllFuzzyMatchedLegs`). Fix: a helper wrapping `memoizeWithTtl` (about 1h) that caches only hits, never misses, because `import-refs.ts` can create a sport. Sports rows are never updated or deleted, so there's nothing to invalidate. Test: memo hit, a miss isn't cached, the TTL, and grading tests unchanged.
2. **`bulk-picks.ts:1027` capper read.** `bulkImportParlaysAction` reads the user's whole capper roster, every column. `resolveOrCreateCapperId` needs only `id` and `name` (`CapperRef`). Narrow it to `{ id, name }`, the same as `import-refs.ts`. Check the line number again after G's changes.
3. **DB Monitor labels** (`src/lib/db-monitor.ts`, `db-monitor-fixtures.ts`, `db-monitor-acceptance-test.ts`). Fixtures need real statement text, captured with `scripts/db-monitor-capture/` (now on main).
   - "Roster cache (grading / import recovery)": `*_roster_players`, no `"id"` in the select. Note that since #302 this read sits behind the Data Cache.
   - "Roster refresh diff": `"id"` in the select; daily cron, expected heavy.
   - "NFL roster names (bulk import)": `nfl_roster_players WHERE active = $1`.
   - "Capper roster": the `(full row)` matcher keys on `notes`, so since #297 the narrow read shows as Unlabeled. Relabel it for the id + name read.
   - The `findOrCreateCapper` name scan (`cappers WHERE userId`, id + name since #297).

## Not started; needs the user's go
- **/picks "load more".** Not specified in this window. The nearest idea discussed was paging the Settled section on the server. That would need SQL totals for the sport chips, the Settled W-L and the units chart, because they're computed from every loaded pick today. On 2026-10-19 the user chose the 31-day cap (#304) over Settled paging. Get the exact scope from the user before starting.
- **Delete the old parlay engine code.** From `docs/parlay-generator-followups.md`:
  - files: `lib/parlay/alternates.ts` (`buildParlaySet`, `lockParlay`), `slip-build.ts`, `pool-swap.ts`'s `buildPoolPrimary`, and `auto-generate.ts`'s `buildAutoParlay` / same-game fill;
  - nothing in the app calls them; only their own tests and the egress-guarded `board-odds-projection-parity` and `board-picks-window-parity` tests use them;
  - move those two tests onto `generator.ts` first. Needs the egress owner's OK.
- **Range-cap follow-up:** none; #304 is complete.
