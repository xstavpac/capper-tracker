# Cache-invalidation contract

## What is cached

One per-user read surface is wrapped in `unstable_cache` (via
`cachedByTag` in `src/server/data/cached.ts`), keyed **and tagged** by a
single string from `src/lib/cache-keys.ts`:

| Surface | Function | Tag | TTL |
|---|---|---|---|
| Dashboard | `getDashboardSummary(userId)` (`stats.ts`) | `cacheKeys.dashboard(userId)` | 60 s |

It computes **only from `prisma.pick` rows** for that user (overall stats,
category breakdown, units chart, counts, recent picks). It contains **no
parlay/leg data** - `/picks` renders parlays as a plain list
(`getParlaysForUser`), uncached and outside this contract entirely.

(There used to be a second surface here, Reports/`getReportsData` - removed
along with the `/reports` page. If this table ever grows a second row again,
give it its own tag rather than reusing `dashboard`.)

## The rule

`revalidatePath` does **not** reliably evict `unstable_cache` entries. Every
code path that mutates a user's `Pick` rows must call, for that user:

```ts
revalidateTag(cacheKeys.dashboard(userId));
```

The `stats` server actions do this through the shared `revalidatePickStats(userId)`
helper (`server/actions/picks.ts`, `server/actions/cappers.ts`). The 60 s TTL
is a backstop for the one path that structurally cannot tag (opportunistic
page-load grading, which runs during render where `revalidateTag` throws).

Tag correctness is by construction: the string passed to `revalidateTag` and
the string the cache registers are the same `cacheKeys.*(userId)` call.

## Pick mutation paths

| # | Path | Write | Dashboard invalidation |
|---|------|-------|-------------------------|
| P1 | `createPickAction` → `createPick` → `createPicksWithEntitlementCheck` (`tx.pick.create`) | 1 pick | ✅ `revalidatePickStats(user.id)` in the action |
| P2 | `bulkImportPicksAction` → `createPicksWithEntitlementCheck` (`tx.pick.create` ×N) | N picks | ✅ inline `revalidateTag` for both, after the create |
| P3 | `updatePickStatusAction` → `updatePickStatus` (`pick.update`) — manual grade / any status edit; there is no field-level pick edit | 1 pick | ✅ `revalidatePickStats(user.id)` in the action |
| P4 | `mergeCappersAction` → `mergeCappers` (`pick.updateMany`, reassign `capperId`) | N picks | ✅ `revalidatePickStats(user.id)` in the action |
| P5 | `renameCapperAction` → `renameCapper` (`capper.name`) | 0 picks (capper row) | ✅ `revalidatePickStats(user.id)` — the name shows in the dashboard recent-picks list |
| P6 | `deleteCapperAction` → `deleteCapper` (`capper.delete` → `Pick.onDelete: Cascade`) | N picks deleted | ✅ `revalidatePickStats(user.id)` in the action |
| **P7** | **`deletePickAction` → `deletePick` (`pick.deleteMany { id, userId }`)** | **1 pick deleted** | **✅ `revalidatePickStats(user.id)` in the action** |
| P8 | Cron `GET /api/cron/grade-picks` → `gradeAllPendingPicks` + `regradeAllFuzzyMatchedPicks` (`pick.update` ×N, all users) | N picks | ✅ per-`changedUserId` `revalidateTag` loop in the route — only users whose pick status actually changed, never a global flush |
| P9 | Page-load grading: `/picks` + `/live/[gameId]` render → `gradePendingPicks` + `regradeFuzzyMatchedPicks` | few picks | ⚠️ **relies on the 60 s TTL** — `revalidateTag` is illegal during render; opportunistic and best-effort, and the page it runs on is not cached |
| P10 | `prisma/seed-dev.ts` (`pick.deleteMany` + `pick.create`) | — | N/A — local dev script, never prod, no running server |
| P11 | `.scratch-reinsert-recovery.mjs` (`pick.createMany`) | — | N/A — historical one-off operator script |

## Leg / ParlayBet mutation paths

`getDashboardSummary` reads only `Pick` rows, so **none of these need
`revalidateTag`**. They use `revalidatePath("/picks", "/dashboard")` to
refresh the parlay list itself, which is uncached.

| # | Path | Write | Notes |
|---|------|-------|-------|
| L1 | `createParlayAction` → `createParlayBet` (`parlayBet.create` + nested `leg`) | parlay + legs | `revalidatePath` only |
| L2 | `updateLegStatusAction` → `updateLegStatus` (`leg.update`) + `recomputeParlayBetStatus` | 1 leg, maybe parlay | `revalidatePath` only |
| L3 | Cron → `gradeAllPendingLegs` / `regradeAllFuzzyMatchedLegs` (`leg.update` ×N) + parent recompute | N legs | no revalidation (cron) |
| L4 | `recomputeParlayBetStatus` (`parlayBet.updateMany`) | 1 parlay | only ever called from L2 / L3 |
| **L5** | **`deleteParlayAction` → `deleteParlayBet` (`parlayBet.deleteMany { id, userId }`, legs cascade via `Leg.onDelete: Cascade`)** | **1 parlay + N legs deleted** | **`revalidatePath("/picks", "/dashboard")` only — no `revalidateTag`. Individual legs are never deletable on their own: a parlay's stake and effective payout are defined by its original leg set and `legIndex` is a unique key assigned once at creation, so removing one leg leaves a malformed bet. The fix for a mis-entered parlay is to delete the whole thing.** |

## Delete scoping

`deletePick` and `deleteParlayBet` filter by **`id` + `userId` only** - never
a name or other text match (standing project rule after a text-`where`
`deleteMany` once ran against production). Each is a single `deleteMany`, so
a row that isn't the caller's simply matches nothing; `count === 0` throws an
opaque "not found" either way. Covered by
`src/server/data/delete-scoping-acceptance-test.ts`.
