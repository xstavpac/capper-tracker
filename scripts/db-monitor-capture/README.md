# DB Monitor fixture capture (local only)

Captures the exact SQL text each code path sends, for
`src/lib/db-monitor-fixtures.ts` (the DB Monitor's label fingerprints are
tested against these). **Local dev DB only**: both scripts abort unless
`DATABASE_URL` and `DIRECT_URL` point at localhost / 127.0.0.1.

How they work: a logging PrismaClient is installed as `globalThis.prisma`
before any app module loads (so `src/lib/prisma.ts` reuses it), `fetch` is
stubbed out, and seeded picks are deleted by id + userId at the end.

- `capture-ops.mts` - the ops-console labels (PR #282): session user, capper
  roster/include/counts, /picks reads, grading cron lookups, refresh-scores
  tendency / decay-delta / team-record / situational reads, zone model.
  Every write the app code issues runs inside a transaction that is rolled
  back, so nothing persists.
- `capture-statements.mts` - the original #279 set (board window, category
  panel, record bundle, slip, comparison, /picks, grading). `MODE=current`
  (default), `pre128` (the retired shapes, on a checkout of the commit
  before #128), or `board`. Grading entry points refuse writes instead of
  rolling them back.

Run from the worktree root (Git Bash; `.mts` because they use top-level
await):

```
H=scripts/db-monitor-capture
WT="$(pwd -W)" OUT=/path/to/out.json NODE_ENV=development \
  node --env-file=.env --env-file=.env.local \
  --require ./$H/server-only-stub.cjs --require ./$H/react-cache-shim.cjs \
  --import tsx ./$H/capture-ops.mts
```

The output is `[{ label, sql }]`, one entry per distinct statement per entry
point. Copy the ones you need into `db-monitor-fixtures.ts` with a `run`
(the commit captured) and the expected label; re-capture rather than
hand-edit. Statements that need live score/stat feeds (the game_results,
nfl_team_stat_snapshots and team_tendency_snapshots upserts) can't run here;
their fixtures came from production's pg_stat_statements text on the DB
Monitor page.

For an older commit: a detached worktree with its own `npm ci` (older
schemas emit fewer picks columns), or a `node_modules` junction when the
lockfile and schema match. `server-only-stub.cjs` tolerates `server-only`
being absent on old SHAs.
