// Guard: after every migration has run, no table in schema `public` may have
// row-level security off. Convention is RLS on with no policies (the app reaches
// the DB as the owning role, which bypasses RLS; PostgREST anon/authenticated
// get nothing). A migration that creates a table and forgets
//   ALTER TABLE "x" ENABLE ROW LEVEL SECURITY;
// fails here and the failing table names are listed.
//
// Needs a migrated database (SKIPped by the runner without DATABASE_URL); runs
// in CI against the service DB after `prisma migrate deploy`. Read-only.
import { prisma } from "@/lib/prisma";

// Prisma's own bookkeeping table is not an app table.
const EXEMPT = new Set(["_prisma_migrations"]);

async function main(): Promise<number> {
  const rows = await prisma.$queryRaw<{ relname: string }[]>`
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relrowsecurity = false
    ORDER BY c.relname`;
  const missing = rows.map((r) => r.relname).filter((n) => !EXEMPT.has(n));
  if (missing.length === 0) {
    console.log("PASS: every table in schema public has row-level security enabled");
    console.log("\nALL CHECKS PASSED");
    return 0;
  }
  console.log(`FAIL: ${missing.length} table(s) in schema public have row-level security OFF: ${missing.join(", ")}`);
  console.log('  Fix: add `ALTER TABLE "<table>" ENABLE ROW LEVEL SECURITY;` to the migration that creates it.');
  console.log("\n1 CHECK(S) FAILED");
  return 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
