// READ-ONLY check: would the NFL box-score match fix resolve the currently
// stuck NFL player-prop picks? Reads PENDING NFL PLAYER_PROP picks whose game
// has a final GameResult, runs the real resolvePlayerProp (live ESPN box score,
// cached roster read) on each, and prints what it WOULD do. Writes nothing:
// every DB read happens inside a SET TRANSACTION READ ONLY transaction, and
// nothing here ever calls an update/create.
//
//   DATABASE_URL=<prod read URL> npx tsx scripts/verify-stuck-nfl-props.ts
//   options: --limit=400   max stuck picks to evaluate (default 400)
//
// Prints the DB host (never credentials) first so you can confirm the target.
import { prisma } from "@/lib/prisma";
import { matchGameResult, resolvePlayerProp } from "@/server/data/grading";

async function main() {
  const limit = Number((process.argv.find((a) => a.startsWith("--limit=")) ?? "--limit=400").split("=")[1]);
  try {
    console.log("DB host:", new URL(process.env.DATABASE_URL ?? "").host);
  } catch {
    console.log("DB host: (unparseable DATABASE_URL)");
  }

  const { picks, games } = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const picks = await tx.pick.findMany({
        where: {
          status: "PENDING",
          betType: "PLAYER_PROP",
          sport: { name: "NFL" },
          gameTime: { lt: new Date(Date.now() - 6 * 3600 * 1000) },
        },
        orderBy: { gameTime: "desc" },
        take: limit,
      });
      const games = await tx.gameResult.findMany({ where: { sportKey: "americanfootball_nfl" } });
      return { picks, games };
    },
    { timeout: 60000 }
  );

  console.log(`stuck PENDING NFL player props (past game time, up to ${limit}): ${picks.length}`);

  const tally = new Map<string, number>();
  const rows: string[] = [];
  for (const p of picks) {
    const m = matchGameResult(games, p);
    if (!m) {
      tally.set("no GameResult matched", (tally.get("no GameResult matched") ?? 0) + 1);
      continue;
    }
    const r = await resolvePlayerProp(p, m.game.externalId, "NFL");
    const key = r.outcome ?? "STILL PENDING: " + r.reason.replace(/"[^"]*"/, '"<name>"');
    tally.set(key, (tally.get(key) ?? 0) + 1);
    rows.push(`${p.gameTime.toISOString().slice(0, 10)}  ${(r.outcome ?? "PENDING").padEnd(8)} ${p.betDetail}${r.outcome ? "" : "   <- " + r.reason}`);
  }

  console.log("\nWould-be outcomes:");
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(5), k);
  console.log("\nPer pick:");
  for (const line of rows) console.log(line);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
