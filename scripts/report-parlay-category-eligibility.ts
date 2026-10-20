// READ-ONLY sanity report for the Parlay Generator's Include Picks categories:
// per sport and per category (betCategory, bet-category.ts), how many pending
// picks on unstarted games there are, how many clear the generator's real 55%
// gate (qualifies, qualification-core.ts, on the capper's all-leagues record in
// the pick's stored category - the same record the generator reads), and how
// many distinct cappers those eligible picks come from.
//
// Writes nothing: everything runs in one transaction opened with
// SET TRANSACTION READ ONLY (Postgres refuses any write inside it), checked
// with SHOW transaction_read_only before the read, and the only statements are
// SELECTs. The connection string comes from PROD_DATABASE_URL in the process
// environment only - never DATABASE_URL, never a file. Run (PowerShell):
//
//   $env:PROD_DATABASE_URL = "<connection string>"; npx tsx scripts/report-parlay-category-eligibility.ts; Remove-Item Env:PROD_DATABASE_URL
//
// Approximation: the generator only sees picks matched to a game on the odds
// board inside its window; this counts every pending pick whose game hasn't
// started. Its counts are an upper bound on what a Generate can draw from.
// --as-of=2026-09-14T12:00:00Z counts as of another moment (for a snapshot).
import { PrismaClient } from "@prisma/client";
import { BET_CATEGORIES, betCategory, type BetCategoryResult } from "@/lib/parlay/bet-category";
import { qualifies } from "@/lib/parlay/qualification-core";

const SPORTS = ["NFL", "NCAAF", "MLB", "NHL", "NBA", "WNBA"];
const CATEGORIES: BetCategoryResult[] = [...BET_CATEGORIES, "UNCLASSIFIED"];
const AS_OF = new Date(process.argv.find((a) => a.startsWith("--as-of="))?.slice("--as-of=".length) ?? Date.now());

type Row = { sport: string; betType: string; capperId: string; category: string | null; wins: number | null; losses: number | null; pushes: number | null };

async function main() {
  const url = process.env.PROD_DATABASE_URL;
  if (!url) {
    console.error("PROD_DATABASE_URL is not set. Pass it for this run only - see the header.");
    process.exit(1);
  }
  if (Number.isNaN(AS_OF.getTime())) {
    console.error("--as-of is not a date");
    process.exit(1);
  }
  console.log("Target host:", url.replace(/\/\/[^@]*@/, "//***@").replace(/\?.*$/, ""));
  console.log("Unstarted as of:", AS_OF.toISOString());

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    const rows = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        const [{ transaction_read_only }] = await tx.$queryRawUnsafe<{ transaction_read_only: string }[]>("SHOW transaction_read_only");
        if (transaction_read_only !== "on") throw new Error("transaction is not read-only - stopping before any read");
        console.log("Transaction: READ ONLY (verified)\n");
        return tx.$queryRaw<Row[]>`
          WITH pend AS (
            SELECT s.name AS sport, p."betType"::text AS "betType", p."capperId", p.category
            FROM picks p
            JOIN sports s ON s.id = p."sportId"
            WHERE p.status = 'PENDING' AND p."gameTime" > ${AS_OF} AND s.name = ANY(${SPORTS}::text[])
          ),
          rec AS (
            SELECT p."capperId", p.category,
              (count(*) FILTER (WHERE p.status = 'WIN'))::int  AS wins,
              (count(*) FILTER (WHERE p.status = 'LOSS'))::int AS losses,
              (count(*) FILTER (WHERE p.status = 'PUSH'))::int AS pushes
            FROM picks p
            WHERE p.status IN ('WIN', 'LOSS', 'PUSH')
              AND (p."capperId", p.category) IN (SELECT DISTINCT "capperId", category FROM pend WHERE category IS NOT NULL)
            GROUP BY 1, 2
          )
          SELECT pend.sport, pend."betType", pend."capperId", pend.category, rec.wins, rec.losses, rec.pushes
          FROM pend
          LEFT JOIN rec ON rec."capperId" = pend."capperId" AND rec.category = pend.category`;
      },
      { timeout: 60_000 }
    );

    type Cell = { pending: number; eligible: number; cappers: Set<string> };
    const table = new Map<string, Cell>();
    const cell = (sport: string, cat: BetCategoryResult) => {
      const k = sport + "|" + cat;
      if (!table.has(k)) table.set(k, { pending: 0, eligible: 0, cappers: new Set() });
      return table.get(k)!;
    };
    for (const r of rows) {
      const cat = betCategory({ betType: r.betType });
      const wins = r.wins ?? 0;
      const losses = r.losses ?? 0;
      const count = wins + losses + (r.pushes ?? 0);
      // Same shape getCapperRecordBundle builds: null with no graded picks, winPct = W / (W + L).
      const record = r.category && count > 0 ? { key: r.category, label: r.category, wins, losses, pushes: r.pushes ?? 0, count, winPct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0 } : null;
      for (const c of [cell(r.sport, cat), cell("ALL SPORTS", cat)]) {
        c.pending++;
        if (qualifies(record as Parameters<typeof qualifies>[0])) {
          c.eligible++;
          c.cappers.add(r.capperId);
        }
      }
    }

    const pad = (s: string | number, n: number) => String(s).padEnd(n);
    console.log(pad("sport", 12) + pad("category", 14) + pad("pending", 9) + pad("eligible", 10) + "cappers (eligible)");
    for (const sport of [...SPORTS, "ALL SPORTS"]) {
      for (const cat of CATEGORIES) {
        const c = table.get(sport + "|" + cat);
        if (!c) continue;
        console.log(pad(sport, 12) + pad(cat, 14) + pad(c.pending, 9) + pad(c.eligible, 10) + c.cappers.size);
      }
    }
    console.log(`\n${rows.length} pending picks on unstarted games read. Nothing was written.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
