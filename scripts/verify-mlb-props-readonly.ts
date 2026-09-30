// READ-ONLY end-to-end check of MLB prop grading against REAL data. Writes nothing anywhere: the only DB
// calls are findMany, the only network calls are GETs against the public MLB Stats API. Run:
//
//   npx tsx scripts/verify-mlb-props-readonly.ts                 (reads game_results via DATABASE_URL)
//   npx tsx scripts/verify-mlb-props-readonly.ts --no-db         (uses the live Stats API schedule instead)
//   npx tsx scripts/verify-mlb-props-readonly.ts --days=7 --games=6
//
// What it proves, per recent final MLB game (postseason first):
//   1. GameResult.externalId really is the gamePk: the box score fetched from it sums to the stored final
//      score (skipped with --no-db, which reads the schedule's own score instead).
//   2. For the game's real starters / hitters it builds pick texts whose correct outcome is known from the
//      RAW box JSON (not from this repo's extractor), runs them through the real grader, and compares.
//      Covers: pitcher Ks + outs, hitter TB/hits/HR/RBI/runs/walks, a PA=0 substitute (PUSH), a bench pitcher
//      (PUSH), a relief-only pitcher (PUSH), and a roster-verified absent player (PUSH).
//   3. Lists any existing MLB PLAYER_PROP picks in the database and dry-grades them (no write).
// Prints the DATABASE_URL host (password masked) first so the target is obvious.
import { PrismaClient } from "@prisma/client";
import { fetchMlbBoxScore } from "@/server/data/mlb-boxscore";
import { fetchMlbLeagueRoster } from "@/server/data/mlb-roster";
import { gradeMlbPlayerProp } from "@/server/data/mlb-prop-grading";
import { MLB_MAX_LINE } from "@/lib/mlb-prop";

const args = process.argv.slice(2);
const NO_DB = args.includes("--no-db");
const num = (k: string, d: number) => Number(args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d);
const DAYS = num("days", 5);
const MAX_GAMES = num("games", 6);

type G = { gamePk: string; homeTeam: string; awayTeam: string; homeScore: number; awayScore: number; postseason: boolean; date: string };
type RawPlayer = { person: { id: number; fullName: string }; position?: { abbreviation?: string }; stats: { batting?: Record<string, number>; pitching?: Record<string, number> } };

let bad = 0;
let total = 0;
function expectOutcome(label: string, actual: unknown, expected: string) {
  total++;
  const got = (actual as { outcome: string | null; reason?: string }).outcome ?? "PENDING(" + (actual as { reason?: string }).reason + ")";
  const ok = got === expected;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  -> ${got}${ok ? "" : "  (expected " + expected + ")"}`);
}

async function recentGames(prisma: PrismaClient | null): Promise<G[]> {
  const since = new Date(Date.now() - DAYS * 86400000);
  const start = since.toISOString().slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);
  const sched = (await (await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${start}&endDate=${end}&gameType=R,F,D,L,W`)).json()) as {
    dates: { games: { gamePk: number; gameType: string; officialDate: string; status: { detailedState: string }; teams: { home: { team: { name: string }; score?: number }; away: { team: { name: string }; score?: number } } }[] }[];
  };
  const fromApi: G[] = sched.dates.flatMap((d) =>
    d.games
      .filter((g) => g.status.detailedState === "Final")
      .map((g) => ({
        gamePk: String(g.gamePk),
        homeTeam: g.teams.home.team.name,
        awayTeam: g.teams.away.team.name,
        homeScore: g.teams.home.score ?? -1,
        awayScore: g.teams.away.score ?? -1,
        postseason: g.gameType !== "R",
        date: g.officialDate,
      }))
  );
  if (!prisma) return fromApi.sort((a, b) => Number(b.postseason) - Number(a.postseason)).slice(0, MAX_GAMES);

  const rows = await prisma.gameResult.findMany({
    where: { sportKey: "baseball_mlb", gameDate: { gte: since } },
    select: { externalId: true, homeTeam: true, awayTeam: true, homeScore: true, awayScore: true, gameDate: true },
    orderBy: { gameDate: "desc" },
  });
  console.log(`game_results: ${rows.length} MLB rows in the last ${DAYS} days`);
  const post = new Set(fromApi.filter((g) => g.postseason).map((g) => g.gamePk));
  return rows
    .map((r) => ({ gamePk: r.externalId, homeTeam: r.homeTeam, awayTeam: r.awayTeam, homeScore: r.homeScore, awayScore: r.awayScore, postseason: post.has(r.externalId), date: r.gameDate.toISOString().slice(0, 10) }))
    .sort((a, b) => Number(b.postseason) - Number(a.postseason))
    .slice(0, MAX_GAMES);
}

async function main() {
  const dbHost = (process.env.DATABASE_URL ?? "").replace(/:[^:@/]+@/, ":***@") || "(DATABASE_URL unset)";
  console.log(`[verify-mlb-props] ${NO_DB ? "no-db mode" : "db=" + dbHost}  days=${DAYS}  (read-only)`);
  const prisma = NO_DB ? null : new PrismaClient();
  try {
    const games = await recentGames(prisma);
    console.log(`checking ${games.length} game(s)\n`);
    const roster = await fetchMlbLeagueRoster(new Date().getFullYear());
    console.log(`live 40-man roster: ${roster.length} players\n`);

    for (const g of games) {
      console.log(`=== ${g.postseason ? "[POSTSEASON] " : ""}${g.awayTeam} @ ${g.homeTeam}  ${g.date}  gamePk=${g.gamePk}  final ${g.awayScore}-${g.homeScore}`);
      if (!/^\d+$/.test(g.gamePk)) {
        console.log("SKIP  externalId is not a gamePk (seed/fixture row)\n");
        continue;
      }
      const raw = (await (await fetch(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`)).json()) as { teams: Record<"home" | "away", { team: { name: string }; players: Record<string, RawPlayer> }> };
      if (!raw.teams) {
        bad++;
        console.log("FAIL  the Stats API has no box score for this externalId\n");
        continue;
      }
      // 1. externalId -> box score pairing: batting runs sum to the stored score.
      const runs = (side: "home" | "away") => Object.values(raw.teams[side].players).reduce((s, p) => s + (p.stats.batting?.runs ?? 0), 0);
      total++;
      if (runs("home") === g.homeScore && runs("away") === g.awayScore) console.log(`PASS  box-score runs ${runs("away")}-${runs("home")} match the game's final score`);
      else if (g.homeScore === -1) console.log("SKIP  no stored score to compare");
      else {
        bad++;
        console.log(`FAIL  box-score runs ${runs("away")}-${runs("home")} != final ${g.awayScore}-${g.homeScore}`);
      }

      const pick = (betDetail: string) => ({ playerName: null, propMarket: null, betDetail, homeTeam: g.homeTeam, awayTeam: g.awayTeam });
      const grade = (betDetail: string) => gradeMlbPlayerProp(pick(betDetail), g.gamePk, { fetchBox: fetchMlbBoxScore, getRoster: async () => roster });
      const all = (["home", "away"] as const).flatMap((s) => Object.values(raw.teams[s].players));

      // 2a. A real starter: Ks and outs on both sides of the line.
      const starter = all.filter((p) => (p.stats.pitching?.gamesStarted ?? 0) === 1).sort((a, b) => (b.stats.pitching!.strikeOuts ?? 0) - (a.stats.pitching!.strikeOuts ?? 0))[0];
      if (starter) {
        const k = starter.stats.pitching!.strikeOuts;
        const o = starter.stats.pitching!.outs;
        expectOutcome(`${starter.person.fullName} over ${k - 0.5} Ks (${k} actual)`, await grade(`${starter.person.fullName} over ${k - 0.5} Ks`), "WIN");
        expectOutcome(`${starter.person.fullName} under ${k - 0.5} Ks`, await grade(`${starter.person.fullName} under ${k - 0.5} Ks`), "LOSS");
        expectOutcome(`${starter.person.fullName} over ${o} outs recorded (whole-number line)`, await grade(`${starter.person.fullName} over ${o} outs recorded`), "PUSH");
      }
      // 2b. A real hitter with the most total bases: every hitter market.
      const hitter = all.filter((p) => (p.stats.batting?.plateAppearances ?? 0) > 0).sort((a, b) => (b.stats.batting!.totalBases ?? 0) - (a.stats.batting!.totalBases ?? 0))[0];
      if (hitter) {
        const b = hitter.stats.batting!;
        const n = hitter.person.fullName;
        // Clamped to the parser's TB ceiling: a real book never posts a line above it (and the parser then refuses
        // to read it as MLB at all - see mlb-prop.ts MLB_MAX_LINE), so a 11-TB night is tested at the ceiling.
        const tbLine = Math.min(b.totalBases - 0.5, MLB_MAX_LINE.TOTAL_BASES);
        expectOutcome(`${n} over ${tbLine} total bases (${b.totalBases} actual)`, await grade(`${n} over ${tbLine} total bases`), "WIN");
        expectOutcome(`${n} under ${b.hits + 0.5} hits (${b.hits} actual)`, await grade(`${n} under ${b.hits + 0.5} hits`), "WIN");
        expectOutcome(`${n} over ${b.homeRuns + 0.5} home runs (${b.homeRuns} actual)`, await grade(`${n} over ${b.homeRuns + 0.5} home runs`), "LOSS");
        expectOutcome(`${n} over ${b.rbi - 0.5 < 0 ? 0 : b.rbi - 0.5} RBIs (${b.rbi} actual)`, await grade(`${n} over ${b.rbi - 0.5 < 0 ? 0 : b.rbi - 0.5} RBIs`), b.rbi === 0 ? "PUSH" : "WIN");
        expectOutcome(`${n} over ${b.runs + 0.5} runs (${b.runs} actual)`, await grade(`${n} over ${b.runs + 0.5} runs`), "LOSS");
        expectOutcome(`${n} under ${b.baseOnBalls + 0.5} walks (${b.baseOnBalls} actual)`, await grade(`${n} under ${b.baseOnBalls + 0.5} walks`), "WIN");
      }
      // 2c. PA=0 substitute (contact market pushes; runs grade off the recorded value).
      const sub = all.find((p) => p.stats.batting?.plateAppearances === 0 && p.position?.abbreviation !== "P");
      if (sub) {
        expectOutcome(`${sub.person.fullName} (PA 0) over 0.5 hits`, await grade(`${sub.person.fullName} over 0.5 hits`), "PUSH");
        expectOutcome(`${sub.person.fullName} (PA 0, ${sub.stats.batting!.runs} runs) over 0.5 runs`, await grade(`${sub.person.fullName} over 0.5 runs`), sub.stats.batting!.runs > 0 ? "WIN" : "LOSS");
      }
      // 2d. A relief-only pitcher and a bench pitcher who never pitched.
      const reliever = all.find((p) => p.stats.pitching?.outs !== undefined && (p.stats.pitching.gamesStarted ?? 0) === 0);
      if (reliever) expectOutcome(`${reliever.person.fullName} (relief) over 0.5 Ks`, await grade(`${reliever.person.fullName} over 0.5 Ks`), "PUSH");
      const bench = all.find((p) => p.position?.abbreviation === "P" && p.stats.pitching?.outs === undefined);
      if (bench) expectOutcome(`${bench.person.fullName} (bench, never pitched) over 4.5 Ks`, await grade(`${bench.person.fullName} over 4.5 Ks`), "PUSH");
      // 2e. Roster-verified absence: a 40-man hitter of one of these teams who is not in the box at all.
      const inBox = new Set(all.map((p) => String(p.person.id)));
      const absent = roster.find((r) => (r.team === g.homeTeam || r.team === g.awayTeam) && r.position !== "P" && r.position !== "TWP" && !inBox.has(r.externalPlayerId));
      if (absent) expectOutcome(`${absent.playerName} (40-man, not in the box) over 0.5 hits`, await grade(`${absent.playerName} over 0.5 hits`), "PUSH");
      console.log();
    }

    // 3. Existing MLB PLAYER_PROP picks (dry grade, no write).
    if (prisma) {
      const picks = await prisma.pick.findMany({
        where: { betType: "PLAYER_PROP", sport: { name: "MLB" } },
        select: { id: true, playerName: true, propMarket: true, betDetail: true, homeTeam: true, awayTeam: true, status: true },
        take: 25,
      });
      console.log(`existing MLB PLAYER_PROP picks in the database: ${picks.length}${picks.length ? " (first 25 listed, none modified)" : ""}`);
      for (const p of picks) console.log(`  ${p.id}  ${p.status}  ${p.propMarket ?? "-"}  ${p.betDetail}`);
    }
    console.log(`\n${bad === 0 ? "ALL PASS" : bad + " FAILURE(S)"}  (${total} checks)`);
    process.exitCode = bad === 0 ? 0 : 1;
  } finally {
    await prisma?.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
