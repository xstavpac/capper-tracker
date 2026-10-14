// READ-ONLY report: graded picks whose side the OLD grading fallback could not
// have told apart. Writes nothing: the only DB call is one findMany. Run:
//
//   npx tsx scripts/report-text-side-ambiguous-picks.ts              (uses DATABASE_URL)
//   npx tsx scripts/report-text-side-ambiguous-picks.ts --samples=25
//
// Prints the DATABASE_URL host (password masked) first so the target is obvious.
//
// Background: a pick with no stored pickedSide is graded by reading its side
// from its text. That read used to be `text.includes(lastWordOfTeamName)` for
// each team, so "Hornets ML" in a Nets - Hornets game ("hornets" contains
// "nets") matched BOTH teams, and gradePick then graded it as the HOME team's
// pick whichever team it was on. This lists every already-graded pick that hit
// that both-teams read, grouped by what the new read (textPickedSide) makes of it:
//
//   AWAY only  - the text names the away team alone. It was graded as the
//                home team's pick: its stored WIN / LOSS is likely backwards.
//   HOME only  - the text names the home team alone. Graded as home: correct.
//   BOTH       - the text really does name both teams. Graded as home; the
//                real side can't be known from the text. New picks like this
//                stay PENDING.
//
// It fixes nothing. Re-grading any of these is a separate, deliberate step.
import { PrismaClient } from "@prisma/client";
import { textPickedSide } from "@/server/data/grading";

const args = process.argv.slice(2);
const SAMPLES = Number(args.find((a) => a.startsWith("--samples="))?.split("=")[1] ?? 10);

const lastWord = (name: string) => name.trim().split(/\s+/).pop()!.toLowerCase();

async function main() {
  const dbHost = (process.env.DATABASE_URL ?? "").replace(/:[^:@/]+@/, ":***@").replace(/\?.*$/, "") || "(DATABASE_URL unset)";
  console.log("Database: " + dbHost + "\n");

  const prisma = new PrismaClient();
  try {
    const picks = await prisma.pick.findMany({
      where: {
        status: { in: ["WIN", "LOSS", "PUSH"] },
        pickedSide: null,
        betType: { in: ["MONEYLINE", "SPREAD", "TEAM_TOTAL"] },
      },
      select: {
        id: true,
        betType: true,
        betDetail: true,
        homeTeam: true,
        awayTeam: true,
        status: true,
        gameTime: true,
        sport: { select: { name: true } },
      },
      orderBy: { gameTime: "desc" },
    });
    console.log(`Graded MONEYLINE / SPREAD / TEAM_TOTAL picks with no stored side: ${picks.length}`);

    type Row = (typeof picks)[number] & { read: "AWAY only" | "HOME only" | "BOTH"; pair: string };
    const hit: Row[] = [];
    for (const p of picks) {
      const detail = (p.betDetail ?? p.homeTeam).toLowerCase();
      const homeNick = lastWord(p.homeTeam);
      const awayNick = lastWord(p.awayTeam);
      const now = textPickedSide(p.betDetail ?? p.homeTeam, p.homeTeam, p.awayTeam);
      // The old read: the mascot anywhere in the text (never for a same-mascot
      // matchup), or the school-name match the new read still carries.
      const sameMascot = homeNick === awayNick;
      const oldHome = (!sameMascot && detail.includes(homeNick)) || now.home;
      const oldAway = (!sameMascot && detail.includes(awayNick)) || now.away;
      if (!oldHome || !oldAway) continue;
      const read = now.ambiguous ? "BOTH" : now.away ? "AWAY only" : "HOME only";
      hit.push({ ...p, read, pair: `${p.sport.name}: ${[homeNick, awayNick].sort().join(" / ")}` });
    }

    console.log(`...of which the old text read matched BOTH teams: ${hit.length}\n`);
    for (const read of ["AWAY only", "HOME only", "BOTH"] as const) {
      const rows = hit.filter((r) => r.read === read);
      console.log(`== ${read}: ${rows.length}`);
      const byPair = new Map<string, number>();
      for (const r of rows) byPair.set(r.pair, (byPair.get(r.pair) ?? 0) + 1);
      for (const [pair, n] of [...byPair].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`   ${String(n).padStart(4)}  ${pair}`);
      for (const r of rows.slice(0, SAMPLES)) {
        console.log(
          `   - ${r.gameTime.toISOString().slice(0, 10)} ${r.sport.name} ${r.betType} ${r.status}  "${r.betDetail ?? ""}"  (${r.awayTeam} @ ${r.homeTeam})  id=${r.id}`
        );
      }
      if (rows.length > SAMPLES) console.log(`   ... ${rows.length - SAMPLES} more (--samples=N to see more)`);
      console.log("");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
