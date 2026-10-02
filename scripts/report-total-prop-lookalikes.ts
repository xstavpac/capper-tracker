// Read-only: NBA/WNBA/NCAAF picks stored as betType TOTAL whose raw text looks
// like a player prop (a player name followed by a stat), i.e. props the import
// parser fell through to TOTAL because it only recognizes NFL/NHL/MLB props.
// Live now classifies strictly by betType, so these land in "Totals".
//   npx tsx scripts/report-total-prop-lookalikes.ts
// No writes. Point DATABASE_URL at the DB to inspect.
import { PrismaClient } from "@prisma/client";

const STAT =
  "points?|pts|rebounds?|rebs?|assists?|asts?|threes|3-?pointers?|3pm|steals?|blocks?|pra|pass(?:ing)? yards?|yards?|yds|receptions?|passing|rushing|receiving|touchdowns?|tds?|sacks?|completions?";
// "LeBron James Over 25.5 Points" / "Caleb Williams o 250.5 pass yds": two+
// capitalized name words, then over/under/o/u, a line, and a stat word.
const LOOKALIKE = new RegExp(`^[A-Z][A-Za-z.'-]+( [A-Z][A-Za-z.'-]+)+ +([Oo]ver|[Uu]nder|[OoUu]) *[0-9]+(\.[0-9]+)? *(${STAT})\b`, "i");

// A game total reads "Lakers Celtics Over 220.5 points" - the two leading
// capitalized words are the teams, not a player. Skip rows whose text mentions
// either side's name (any 4+ letter word of homeTeam/awayTeam).
function mentionsTeam(text: string, teams: string[]): boolean {
  const t = text.toLowerCase();
  return teams.some((team) => team.toLowerCase().split(/\s+/).some((w) => w.length >= 4 && t.includes(w)));
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.pick.findMany({
      where: { betType: "TOTAL", sport: { name: { in: ["NBA", "WNBA", "NCAAF"] } } },
      select: { betDetail: true, homeTeam: true, awayTeam: true, sport: { select: { name: true } } },
    });
    const hits = rows.filter(
      (r) => r.betDetail && LOOKALIKE.test(r.betDetail) && !mentionsTeam(r.betDetail, [r.homeTeam, r.awayTeam])
    );
    const count = (list: typeof rows, sport: string) => list.filter((r) => r.sport.name === sport).length;
    for (const sport of ["NBA", "WNBA", "NCAAF"]) {
      console.log(`${sport}: ${count(hits, sport)} prop-looking of ${count(rows, sport)} TOTAL picks`);
      for (const r of hits.filter((h) => h.sport.name === sport).slice(0, 5)) console.log("   ", r.betDetail);
    }
    console.log("total prop-looking TOTAL picks:", hits.length);
  } finally {
    await prisma.$disconnect();
  }
}
main();
