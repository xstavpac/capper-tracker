// Read-only: saved cappers whose NAME is a team phrase ("Tampa Bay Rays",
// "Rays", "UNC", "Tampa Bay") or an NFL roster player ("James Cook"). They
// exist because catalog import once misread a bet line as a capper header;
// the picks under them belong to whoever was the active capper in that paste.
// Merge them by hand - this script changes nothing.
//   npx tsx scripts/report-team-named-cappers.ts
// No writes. Point DATABASE_URL at the DB to inspect.
//
// Team phrases come from parse-catalog's own lists (isTeamPhrase), the same
// test the importer applies. FCS schools are recognized from the live game
// feed at import time and are NOT covered here: a capper named after an FCS
// school only shows up if the name is also in the hand-kept lists.
import { PrismaClient } from "@prisma/client";
import { isTeamPhrase } from "../src/lib/parse-catalog";
import { isKnownFullPlayerName } from "../src/lib/player-roster-fallback";

async function main() {
  const prisma = new PrismaClient();
  try {
    const [cappers, roster] = await Promise.all([
      prisma.capper.findMany({
        select: { id: true, userId: true, name: true, createdAt: true, _count: { select: { picks: true, parlayBets: true } } },
        orderBy: [{ userId: "asc" }, { name: "asc" }],
      }),
      prisma.nflRosterPlayer.findMany({ select: { fullName: true } }).catch(() => []),
    ]);
    const rosterNames = roster.map((r) => r.fullName);
    const isPlayerName = (name: string) => /^[A-Za-z][A-Za-z'.-]*(\s+[A-Za-z][A-Za-z'.-]*){1,3}$/.test(name.trim()) && isKnownFullPlayerName(name.trim(), rosterNames);

    const rows = cappers
      .map((c) => ({ ...c, kind: isTeamPhrase(c.name) ? "team" : isPlayerName(c.name) ? "player" : null }))
      .filter((c) => c.kind !== null);

    console.log(`${cappers.length} cappers checked, ${rows.length} named like a team or player\n`);
    console.log("| Capper name | Kind | Picks | Parlays | Created | Capper id | User id |");
    console.log("|---|---|---|---|---|---|---|");
    for (const c of rows) {
      console.log(`| ${c.name} | ${c.kind} | ${c._count.picks} | ${c._count.parlayBets} | ${c.createdAt.toISOString().slice(0, 10)} | ${c.id} | ${c.userId} |`);
    }
  } finally {
    await prisma.$disconnect();
  }
}
main();
