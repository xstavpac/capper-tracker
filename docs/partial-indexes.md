# Partial indexes (raw-SQL migrations)

Prisma 5 (`@prisma/client ^5.20`) has no schema syntax for a partial index
(`CREATE INDEX … WHERE …`). Any partial index in this repo is therefore created
by a hand-written SQL migration and is **not** declared in `schema.prisma`.

| Index | Table | Migration | Serves |
|---|---|---|---|
| `picks_fuzzy_regrade_idx` `("sportId", "gameTime") WHERE "gradedViaFuzzyMatch" = true` | `picks` | `20260929090000_add_pick_capper_and_fuzzy_regrade_indexes` | `regradeAllFuzzyMatchedPicks` (`grading.ts`): `WHERE sportId = ? AND status IN (WIN,LOSS,PUSH) AND gradedViaFuzzyMatch = true AND gameTime >= ? ORDER BY gameTime DESC LIMIT ?` |
| `cappers_user_lower_name_key` UNIQUE `("userId", lower(btrim(name)))` (an expression index, not partial) | `cappers` | `20260929120000_add_capper_unique_name_index` | Race backstop for `findOrCreateCapper` (`capper-find-or-create.ts`): one capper name per user, case-insensitive, edge spaces ignored. `CREATE UNIQUE INDEX` **fails, and so does the deploy, if a user already has colliding names** - run `SELECT "userId", lower(btrim(name)) AS n, count(*) FROM cappers GROUP BY 1, 2 HAVING count(*) > 1;` first (must return 0 rows). A violation surfaces as Prisma `P2002` with `meta.target = ["userId", "lower(btrim(name))"]` (the expression text, not an index name). |
| `picks_user_capper_streak_idx` `("userId", "capperId", "gameTime" DESC, "createdAt" DESC, ("id" COLLATE "C") DESC) INCLUDE (status, units, odds)` (a covering expression index on the `id` collation, not partial) | `picks` | `20260930090000_add_picks_capper_streak_index` | The /cappers Hottest / Coldest panels' bounded per-capper streak lookup (`cappers-page-aggregates.ts`): `WHERE userId = ? AND capperId = ? AND status IN (WIN,LOSS) ORDER BY gameTime DESC, createdAt DESC, id COLLATE "C" DESC LIMIT n` reads the newest picks off the index instead of sorting the capper's whole history. |

## Drift behaviour (checked with Prisma 5.22)

Against a database that has the index, `prisma migrate diff --from-url <db>
--to-schema-datamodel prisma/schema.prisma --script` reports **an empty
migration** — Prisma does not model, and does not try to drop, an index it
cannot represent. `prisma migrate deploy` (what the build runs) only applies
migration files and never diffs. So nothing in the current toolchain will drop
it. Two things could still remove it, so treat it as load-bearing:

1. `prisma migrate dev` against a database that has drifted may offer to reset;
   never accept a reset of a shared/production database (already project policy).
2. A future Prisma major version that learns partial indexes may want them
   declared in the schema; when upgrading, re-run the `migrate diff` above and
   adapt.

Every schema comment next to a model that has such an index says so
(see the `Pick` model).

## Adding another one

Write the migration by hand (`prisma migrate dev --create-only`, then replace
the SQL), plain `CREATE INDEX` (not `CONCURRENTLY`: Prisma runs a migration file
as one transaction and `CONCURRENTLY` cannot), add a row to the table above, and
leave a comment on the model in `schema.prisma`.
