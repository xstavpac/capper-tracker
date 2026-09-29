# Partial indexes (raw-SQL migrations)

Prisma 5 (`@prisma/client ^5.20`) has no schema syntax for a partial index
(`CREATE INDEX … WHERE …`). Any partial index in this repo is therefore created
by a hand-written SQL migration and is **not** declared in `schema.prisma`.

| Index | Table | Migration | Serves |
|---|---|---|---|
| `picks_fuzzy_regrade_idx` `("sportId", "gameTime") WHERE "gradedViaFuzzyMatch" = true` | `picks` | `20260929090000_add_pick_capper_and_fuzzy_regrade_indexes` | `regradeAllFuzzyMatchedPicks` (`grading.ts`): `WHERE sportId = ? AND status IN (WIN,LOSS,PUSH) AND gradedViaFuzzyMatch = true AND gameTime >= ? ORDER BY gameTime DESC LIMIT ?` |

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
