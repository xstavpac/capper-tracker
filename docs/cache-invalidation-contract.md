# Cache-invalidation contract

## What is cached

Two per-user read surfaces are wrapped in `unstable_cache` (via
`cachedByTag` in `src/server/data/cached.ts`). Both are **invalidated by the
same tag**, `cacheKeys.dashboard(userId)` from `src/lib/cache-keys.ts`:

| Surface | Function | Cache key | Tag | TTL |
|---|---|---|---|---|
| Dashboard summary | `getDashboardSummary(userId)` (`stats.ts`) | `cacheKeys.dashboard(userId)` | `cacheKeys.dashboard(userId)` | 60 s |
| Dashboard capper panels | `getCapperPanels(userId, filter?)` (`capper-panels.ts`) | `capperPanelsCacheKey(userId, filter)` (per user **and** per filter) | `cacheKeys.dashboard(userId)` | 60 s |

Both compute **only from `prisma.pick` rows** for that user, plus the capper
roster for `getCapperPanels` (name, colorTag, and `isFavorite`, which orders
ties). They contain **no parlay/leg data** - `/picks` renders parlays as a
plain list (`getParlaysForUser`), uncached and outside this contract entirely.

`cachedByTag` identifies a cache entry by its `key` string (Next also keys on
the callback's source text, which is identical for every user/filter), so
anything that changes the result - user, sport filter, category filter - must
be in the key. `getCapperPanels` therefore uses its own per-filter key and
attaches the shared dashboard tag through `cachedByTag`'s `tags` argument. Its
only real caller (`/dashboard`) passes no filter.

(There used to be another surface here, Reports/`getReportsData` - removed
along with the `/reports` page. Any new surface that is invalidated by exactly
the same mutations can join the `dashboard` tag as `getCapperPanels` does;
one with different invalidation triggers needs its own tag.)

## The rule

`revalidatePath` does **not** reliably evict `unstable_cache` entries. Every
code path that mutates a user's `Pick` rows must call, for that user:

```ts
revalidateTag(cacheKeys.dashboard(userId));
```

The `stats` server actions do this through the shared `revalidatePickStats(userId)`
helper (`server/actions/picks.ts`, `server/actions/cappers.ts`). The 60 s TTL
is a backstop only; every path below tags. (On-view grading used to be the
exception: it ran during render, where `revalidateTag` throws. It now runs in
a server action after paint - see P9.)

Tag correctness is by construction: the string passed to `revalidateTag` and
the string the cache registers are the same `cacheKeys.*(userId)` call.

## Pick mutation paths

| # | Path | Write | Dashboard invalidation |
|---|------|-------|-------------------------|
| P1 | `createPickAction` → `createPick` → `createPicksWithEntitlementCheck` (`tx.pick.create`) | 1 pick | ✅ `revalidatePickStats(user.id)` in the action |
| P2 | `bulkImportPicksAction` → `createPicksWithEntitlementCheck` (`tx.pick.create` ×N) | N picks | ✅ inline `revalidateTag` for both, after the create |
| P3 | `updatePickStatusAction` → `updatePickStatus` (`pick.update`) — manual grade / any status edit; there is no field-level pick edit | 1 pick | ✅ `revalidatePickStats(user.id)` in the action |
| P4 | `mergeCappersAction` → `mergeCappers` (`pick.updateMany`, reassign `capperId`) | N picks | ✅ `revalidatePickStats(user.id)` in the action |
| P5 | `renameCapperAction` → `renameCapper` (`capper.name`) | 0 picks (capper row) | ✅ `revalidatePickStats(user.id)` — the name shows in the dashboard recent-picks list and the capper panels |
| P5b | `toggleFavoriteCapperAction` → `toggleFavoriteCapper` (`capper.isFavorite`) | 0 picks (capper row) | ✅ `revalidatePickStats(user.id)` — favorites sort first in the roster, which breaks ties between equally-ranked cappers in the capper panels |
| P6 | `deleteCapperAction` → `deleteCapper` (`capper.delete` → `Pick.onDelete: Cascade`) | N picks deleted | ✅ `revalidatePickStats(user.id)` in the action |
| **P7** | **`deletePickAction` → `deletePick` (`pick.deleteMany { id, userId }`)** | **1 pick deleted** | **✅ `revalidatePickStats(user.id)` in the action** |
| P8 | Cron `GET /api/cron/grade-picks` → `gradeAllPendingPicks` + `regradeAllFuzzyMatchedPicks` (`pick.update` ×N, all users) | N picks | ✅ per-`changedUserId` `revalidateTag` loop in the route — only users whose pick status actually changed, never a global flush |
| P9 | On-view grading: `/picks` + `/live/[gameId]` mount `GradeDuePicks` when a loaded pending pick's game is over (`lib/gradeable-picks.ts`) → `gradeDuePicksAction` → `gradeUserPagePicks` → `gradePendingPicks` | few picks | ✅ `revalidateTag` in the action, only when a status actually changed. Not part of the render any more. |
| P10 | `prisma/seed-dev.ts` (`pick.deleteMany` + `pick.create`) | — | N/A — local dev script, never prod, no running server |
| P11 | `.scratch-reinsert-recovery.mjs` (`pick.createMany`) | — | N/A — historical one-off operator script |

## Leg / ParlayBet mutation paths

Neither `getDashboardSummary` nor `getCapperPanels` reads Leg/ParlayBet rows,
so **none of these need `revalidateTag`**. They use `revalidatePath("/picks", "/dashboard")` to
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
