// Applies pending Prisma migrations to the deploy's database as part of the
// Vercel build command (see package.json "build"), BEFORE `next build`.
//
// Why this exists: on 2026-09-06 the migration adding `game_results.linescoreJson`
// (PR #20) was merged and deployed, but nothing ever ran `prisma migrate deploy`
// against production - the build script was `prisma generate && next build`,
// with no migration step anywhere in the pipeline (CI only migrates its own
// throwaway Postgres). Every query that loaded a GameResult row then threw
// P2022 for ~14 hours, taking down grade-picks, refresh-scores, and page-load
// grading until the migration was applied by hand. This closes that gap: a
// committed-but-unapplied migration now fails the production build loudly at
// deploy time instead of silently breaking runtime hours later.
//
// Scope:
//   - Production Vercel builds only. Preview builds have no DATABASE_URL and
//     must never run migrations (they'd either fail the build or, worse, point
//     at prod). Local `npm run build` has no VERCEL_ENV and is skipped too.
//   - Additive migrations (this project only ever adds columns / enum values /
//     indexes) are backward compatible, so running them before the new code is
//     live is the correct order. A destructive migration would need a different
//     rollout and is out of scope here.
//   - Prisma takes a Postgres advisory lock for the duration, so two concurrent
//     Vercel builds can't double-apply.
//
// A migration failure ABORTS the build. That is deliberate: shipping code that
// expects a schema the database doesn't have is exactly the outage this guards
// against.

import { execSync } from "node:child_process";

const vercelEnv = process.env.VERCEL_ENV ?? "local";

if (vercelEnv !== "production") {
  console.log(`[deploy-migrate] VERCEL_ENV=${vercelEnv} — skipping prisma migrate deploy (production builds only)`);
  process.exit(0);
}

if (!process.env.DATABASE_URL) {
  console.error("[deploy-migrate] production build but DATABASE_URL is unset — aborting rather than shipping unmigrated");
  process.exit(1);
}

console.log("[deploy-migrate] production build — applying pending migrations…");
try {
  execSync("npx prisma migrate deploy", { stdio: "inherit" });
  console.log("[deploy-migrate] migrations up to date");
} catch {
  console.error("[deploy-migrate] prisma migrate deploy FAILED — aborting the build");
  process.exit(1);
}
