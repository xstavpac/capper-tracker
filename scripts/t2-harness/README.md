# T2 verification harness

Read-only production snapshot → anonymized local dataset → disposable-DB
old-vs-new diffing, for validating a call-site migration (starting with
Cappers/T3) before it ships, with no staging environment.

This document covers **only how to use the harness**. It intentionally says
nothing about T3's own design (the shared pick-aggregate module) - that
stays out of the repo until the design itself is confirmed and separately
written up.

## Status

Built and validated (`validate-old-vs-old.mjs` and `self-test-failure-modes.mjs`
both pass - see "Validating the harness itself" below). **Not yet connected to
real production data**: no production database credential is available in
this environment (checked `.env`/`.env.local` - both point at a local dev
DB; the production connection string documented elsewhere has its password
redacted and isn't stored here). See "Getting a real snapshot" for what's
needed to unblock that, and "Validating the harness itself" for how its
correctness was proven without one, using synthetic fixture data instead.

## Why this can never hold a live production connection

`extract-from-dump.mjs` - the only script that touches anything
production-derived - takes a **file path**, never a connection string, and
has no flag that accepts one. That's deliberate, not a missing feature: a
static dump file is structurally incapable of writing back to production,
so there is no read-only-credential-management burden anywhere in this
harness at all. See that script's own header comment for the two sanctioned
ways to produce that file (a Supabase dashboard backup download, or a
`pg_dump` you run by hand against a read-only role you create once).

Every other script in this harness only ever touches **local** Postgres
(via `T2_PG_HOST`/`T2_PG_PORT`/`T2_PG_ADMIN_USER`, default
`localhost:5432`/`postgres`), and every one of them calls
`lib/prod-guard.mjs`'s `assertNotProd()` on whatever URL it's about to use -
the same `kbmdydpacvdmbemcwhry` / `pooler.supabase.com` marker check as
`scripts/guard-not-prod-db.mjs` and `prisma/seed-dev.ts` use elsewhere in
this repo (that pattern exists because of a real incident - see those
files' own comments). Defense in depth: nothing here is *supposed* to see a
prod credential, and it's guarded anyway.

## Prerequisites

- A local Postgres **server** running and reachable at
  `localhost:5432` as user `postgres` (this repo's dev setup already
  expects one - see `.env`'s `DATABASE_URL`). Client + server binaries
  (`psql`, `createdb`, `dropdb`, `pg_dump`, `pg_restore`) must be on `PATH`,
  or point `T2_PG_BIN_DIR` at their directory.
- `npx prisma migrate deploy` runnable from the repo root (used to stand up
  the schema on a fresh disposable DB for the `fixtures` source).
- `tsx` (already a devDependency).

## Getting a real snapshot

1. Produce a dump file via one of the two read-only mechanisms in
   `extract-from-dump.mjs`'s header comment. You end up with a `.dump` file
   somewhere on disk - never a connection string handed to this repo.
2. `node scripts/t2-harness/extract-from-dump.mjs --dump-file=<path> --label=<name>`
   This restores it into a throwaway local staging DB, runs
   `anonymize.sql` (see its header comment for the exact field-by-field PII
   inventory and the transformation applied to each), re-dumps the
   anonymized result to `scripts/t2-harness/.snapshots/<name>.dump`, and
   drops the staging DB. The staging DB never leaves this machine and is
   never queried by application code - the whole point is that it exists
   only long enough to be anonymized.
3. That `.snapshots/<name>.dump` file is the reusable artifact every future
   `run-diff.mjs --source=snapshot:...` run restores into its own disposable
   DB. `.snapshots/` is gitignored - it holds real (anonymized) user data
   and must never be committed.

## Running a diff

```
node scripts/t2-harness/run-diff.mjs \
  --source=fixtures \                         # or: snapshot:scripts/t2-harness/.snapshots/<name>.dump
  --impl-old=old \                             # registry key, see capture-output.ts
  --impl-new=old \                             # swap to a T3 registry key once one exists
  --fixture-user=A                             # or: --user-id=<cuid> (required for --source=snapshot)
```

Each invocation: creates one uniquely-named disposable database
(`t2_run_<epochSeconds>_<random>`) → applies the schema (fixtures source) or
restores the snapshot's own schema+data (snapshot source) → runs
`capture-output.ts` once per `--impl-*` value, each in its own child process
against the same disposable DB → structurally diffs the two JSON outputs
(`lib/deep-diff.mjs` - compares the actual return values of the Cappers-page
data functions, not raw rows or internal Maps) → drops the disposable DB in
a `finally` block, success or failure. Exit code 0 = no differences, 1 =
differences found (printed as `path: old -> new`) or a run-time error.

`--keep-db` skips the final drop, for debugging a specific run by hand
(`psql postgresql://postgres@localhost:5432/t2_run_<id>`).

### Registering a new implementation (T3, once it exists)

Add one entry to `IMPLEMENTATIONS` in `capture-output.ts`:

```ts
t3: async () => (await import("@/server/data/<t3-module>")) as unknown as CappersImpl,
```

Nothing else in this harness changes. Then:

```
node scripts/t2-harness/run-diff.mjs --source=snapshot:scripts/t2-harness/.snapshots/<name>.dump --impl-old=old --impl-new=t3 --user-id=<a real anonymized user's cuid>
```

## Cleaning up

Normal runs clean up after themselves automatically. If a run is killed
mid-way (crash, Ctrl-C, machine sleep), its `t2_run_*` database is left
behind - `CREATE DATABASE` has already committed by the time any later step
could fail, so there is no way to make this impossible, only easy to
recover from:

```
node scripts/t2-harness/lib/disposable-db.mjs --list                                    # see what's out there, with age
node scripts/t2-harness/lib/disposable-db.mjs --cleanup-orphans [--max-age-minutes=60]   # drop anything older than the threshold (default 60 min)
```

No harness run should legitimately approach 60 minutes; treat anything that
old as orphaned. Run `--cleanup-orphans` after a crash, or periodically as
routine hygiene.

## Validating the harness itself

Two scripts prove the harness is trustworthy before it's used on a real T3
implementation - both currently pass, run against synthetic fixture data
(`fixtures.ts`) since no production access exists yet in this environment:

```
node scripts/t2-harness/validate-old-vs-old.mjs        # old vs old, both fixture users: zero diffs expected, AND each of
                                                          # the 6 required scenarios is asserted to have actually been
                                                          # exercised (not just "the diff was empty")
node scripts/t2-harness/self-test-failure-modes.mjs     # old vs two deliberately-broken variants (defined only inside
                                                          # capture-output.ts, never touching /cappers or T3 source):
                                                          # asserts the diff DOES catch the capper.name gap and the
                                                          # zero-pick-capper-disappearance regression found in the T3
                                                          # field-equivalence audit.
```

Re-run both after any change to `lib/deep-diff.mjs`, `capture-output.ts`,
or `fixtures.ts` - a false positive or false negative in either would make
every subsequent diff run untrustworthy.

## File map

| File | Role |
|---|---|
| `lib/prod-guard.mjs` | Shared PROD_MARKERS denylist + `assertNotProd()`, called by every DB-touching script here. |
| `lib/disposable-db.mjs` | Run-scoped disposable DB lifecycle: create/drop, `--list`, `--cleanup-orphans`. |
| `lib/deep-diff.mjs` | Generic structural diff over the JSON-shaped output of the data functions; `formatDiffReport()` for actionable terminal output. |
| `anonymize.sql` | The PII inventory (as a header comment) and the actual anonymizing UPDATEs, applied to a staging DB restored from a production dump. |
| `extract-from-dump.mjs` | The only script that touches anything production-derived - takes a dump FILE, never a connection string. Restore → anonymize → re-dump → drop staging. |
| `fixture-user-ids.mjs` | Side-effect-free constants shared by `fixtures.ts` and `capture-output.ts` (kept separate so importing the constant doesn't re-run the seeder). |
| `fixtures.ts` | Synthetic dataset (two users) covering all 6 required validation scenarios - stand-in for real snapshot data until production access exists. |
| `capture-output.ts` | Runs one named implementation's Cappers data functions against `DATABASE_URL` and prints one JSON object (scenario name → output) to stdout. Holds the `IMPLEMENTATIONS` registry (the T3 plug-in point) and the two self-test-only broken variants. |
| `run-diff.mjs` | Orchestrator: disposable DB → load data → capture both impls → diff → drop DB. Also the CLI entry point. |
| `validate-old-vs-old.mjs` | Item-4 validation: old vs old across both fixture users, asserts zero diffs AND that each scenario was meaningfully exercised. |
| `self-test-failure-modes.mjs` | Item-3 validation: old vs two broken variants, asserts the diff DOES flag them. |
