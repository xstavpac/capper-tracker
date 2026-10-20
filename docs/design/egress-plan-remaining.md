# Egress plan: what's left (handoff)

What remains of the 2026-10-19 DB Monitor egress plan, written so another session can pick it up cold. Update it as items finish.

## Done
| PR | What | Merge |
|---|---|---|
| #297 | Cappers: roster and find-or-create scan read `id` + `name` | ebd0596 |
| #301 | /picks: 18-column select, no capper/sport/league includes, names joined from the roster | 44ddf1e |
| #302 | Roster caches: rows in the Data Cache (24h, one entry per league), refresh-rosters revalidates every committed league | df0b455 |
| #304 | /picks: date range clamped to its last 31 days | e868640 |
| #310 | Tendency history: one snapshot read per decay-delta pass (two per sync), bounded to the pass's asOf span; parity test `tendency-history-acceptance-test.ts` | 916289e |
| #311 | Grading: `getSportIdByName` (`sport-ids.ts`), a sport's id memoized per process for 1h, misses never cached | 597f63f |
| #312 | Parlay import (`bulkImportParlaysAction`): capper roster read `id` + `name` | aacbcd6 |

**Open: the DB Monitor labels PR** (branch `egress/db-monitor-labels`). It's a visible admin change, opened and waiting for the user's preview check, not merged. It adds labels `Roster cache (grading / import recovery)`, `Roster refresh diff` (expected-heavy, daily full table), `NFL roster names (bulk import)`, `Capper names (import / find-or-create)` and `Tendency history (batch)`, and renames `Capper roster (full row)` to `Capper roster`. The fixtures were captured with `scripts/db-monitor-capture/capture-ops.mts` (new runs added at the end of the script).

Open checks:
- From #302: the first real revalidation is the 10:45 UTC refresh-rosters run. Confirm on /admin/crons that it logged, and that prop grading and import recovery still read the roster.
- After the labels PR ships, a clean post-reset DB Monitor window should show the targets' new shapes: `Tendency history (batch)` about twice per refresh-scores run instead of about 128 `Tendency history (model)` calls; the roster reads about daily; `Grading sport lookup` about once per sport per instance per hour.

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

## Not started; needs the user's go
- **/picks "load more".** Not specified in this window. The nearest idea discussed was paging the Settled section on the server. That would need SQL totals for the sport chips, the Settled W-L and the units chart, because they're computed from every loaded pick today. On 2026-10-19 the user chose the 31-day cap (#304) over Settled paging. Get the exact scope from the user before starting.
- **Delete the old parlay engine code.** From `docs/parlay-generator-followups.md`:
  - files: `lib/parlay/alternates.ts` (`buildParlaySet`, `lockParlay`), `slip-build.ts`, `pool-swap.ts`'s `buildPoolPrimary`, and `auto-generate.ts`'s `buildAutoParlay` / same-game fill;
  - nothing in the app calls them; only their own tests and the egress-guarded `board-odds-projection-parity` and `board-picks-window-parity` tests use them;
  - the user scoped it (2026-10-20) as its own PR, outside the egress window: move those two tests onto `generator.ts` first, then delete the four.
- **Range-cap follow-up:** none; #304 is complete.
