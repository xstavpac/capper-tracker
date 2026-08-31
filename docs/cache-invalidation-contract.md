# Cache-invalidation contract

## What is cached

Two per-user read surfaces are wrapped in `unstable_cache` (via
`cachedByTag` in `src/server/data/cached.ts`), keyed **and tagged** by a
single string from `src/lib/cache-keys.ts`:

| Surface | Function | Tag | TTL |
|---|---|---|---|
| Dashboard | `getDashboardSummary(userId)` (`stats.ts`) | `cacheKeys.dashboard(userId)` | 60 s |
| Reports | `getReportsData(userId)` (`stats.ts`) | `cacheKeys.reports(userId)` | 60 s |

Both compute **only from `prisma.pick` rows** for that user (overall stats,
category breakdown, units chart, counts, recent picks / the six report
groupings). They contain **no parlay/leg data** - the parlay numbers on
`/reports` come from `getParlayReportsData`, which is a separate,
**uncached** query.

## The rule

`revalidatePath` does **not** reliably evict `unstable_cache` entries. Every
code path that mutates a user's `Pick` rows must call, for that user:

```ts
revalidateTag(cacheKeys.dashboard(userId));
revalidateTag(cacheKeys.reports(userId));
```

The `stats` server actions do this through the shared `revalidatePickStats(userId)`
helper (`server/actions/picks.ts`, `server/actions/cappers.ts`). The 60 s TTL
is a backstop for the one path that structurally cannot tag (opportunistic
page-load grading, which runs during render where `revalidateTag` throws).

Tag correctness is by construction: the string passed to `revalidateTag` and
the string the cache registers are the same `cacheKeys.*(userId)` call.

## Pick mutation paths

| # | Path | Write | Dashboard + Reports invalidation |
|---|------|-------|----------------------------------|
| P1 | `createPickAction` → `createPick` → `createPicksWithEntitlementCheck` (`tx.pick.create`) | 1 pick | ✅ `revalidatePickStats(user.id)` in the action |
| P2 | `bulkImportPicksAction` → `createPicksWithEntitlementCheck` (`tx.pick.create` ×N) | N picks | ✅ inline `revalidateTag` for both, after the create |
| P3 | `updatePickStatusAction` → `updatePickStatus` (`pick.update`) — manual grade / any status edit; there is no field-level pick edit | 1 pick | ✅ `revalidatePickStats(user.id)` in the action |
| P4 | `mergeCappersAction` → `mergeCappers` (`pick.updateMany`, reassign `capperId`) | N picks | ✅ `revalidatePickStats(user.id)` in the action |
| P5 | `renameCapperAction` → `renameCapper` (`capper.name`) | 0 picks (capper row) | ✅ `revalidatePickStats(user.id)` — the name shows in the Reports `byCapper` grouping and the dashboard recent-picks list |
| P6 | `deleteCapperAction` → `deleteCapper` (`capper.delete` → `Pick.onDelete: Cascade`) | N picks deleted | ✅ `revalidatePickStats(user.id)` in the action |
| **P7** | **`deletePickAction` → `deletePick` (`pick.deleteMany { id, userId }`)** | **1 pick deleted** | **✅ `revalidatePickStats(user.id)` in the action** |
| P8 | Cron `GET /api/cron/grade-picks` → `gradeAllPendingPicks` + `regradeAllFuzzyMatchedPicks` (`pick.update` ×N, all users) | N picks | ✅ per-`changedUserId` `revalidateTag` loop in the route — only users whose pick status actually changed, never a global flush |
| P9 | Page-load grading: `/picks` + `/live/[gameId]` render → `gradePendingPicks` + `regradeFuzzyMatchedPicks` | few picks | ⚠️ **relies on the 60 s TTL** — `revalidateTag` is illegal during render; opportunistic and best-effort, and the page it runs on is not cached |
| P10 | `prisma/seed-dev.ts` (`pick.deleteMany` + `pick.create`) | — | N/A — local dev script, never prod, no running server |
| P11 | `.scratch-reinsert-recovery.mjs` (`pick.createMany`) | — | N/A — historical one-off operator script |

## Leg / ParlayBet mutation paths

`getDashboardSummary` / `getReportsData` read only `Pick` rows, so **none of
these need `revalidateTag`**. They use `revalidatePath("/picks", "/reports",
"/dashboard")` to refresh the parlay sections and the uncached
`getParlayReportsData`.

| # | Path | Write | Notes |
|---|------|-------|-------|
| L1 | `createParlayAction` → `createParlayBet` (`parlayBet.create` + nested `leg`) | parlay + legs | `revalidatePath` only |
| L2 | `updateLegStatusAction` → `updateLegStatus` (`leg.update`) + `recomputeParlayBetStatus` | 1 leg, maybe parlay | `revalidatePath` only |
| L3 | Cron → `gradeAllPendingLegs` / `regradeAllFuzzyMatchedLegs` (`leg.update` ×N) + parent recompute | N legs | no revalidation (cron) |
| L4 | `recomputeParlayBetStatus` (`parlayBet.updateMany`) | 1 parlay | only ever called from L2 / L3 |
| **L5** | **`deleteParlayAction` → `deleteParlayBet` (`parlayBet.deleteMany { id, userId }`, legs cascade via `Leg.onDelete: Cascade`)** | **1 parlay + N legs deleted** | **`revalidatePath("/picks", "/reports", "/dashboard")` only — no `revalidateTag`. Individual legs are never deletable on their own: a parlay's stake and effective payout are defined by its original leg set and `legIndex` is a unique key assigned once at creation, so removing one leg leaves a malformed bet. The fix for a mis-entered parlay is to delete the whole thing.** |

## Delete scoping

`deletePick` and `deleteParlayBet` filter by **`id` + `userId` only** - never
a name or other text match (standing project rule after a text-`where`
`deleteMany` once ran against production). Each is a single `deleteMany`, so
a row that isn't the caller's simply matches nothing; `count === 0` throws an
opaque "not found" either way. Covered by
`src/server/data/delete-scoping-acceptance-test.ts`.
