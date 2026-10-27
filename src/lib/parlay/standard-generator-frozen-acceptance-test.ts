// Regression guard for the Standard Parlay Generator while Consensus Hybrid is
// built beside it: buildGeneratedParlay on a frozen, deterministic snapshot must
// produce exactly the output frozen in standard-generator-frozen.json (captured
// from origin/main at 06978b2, the commit before the hybrid action PR). Covers
// the Primary, Hedge and Contrarian for three setting shapes. Pure - no DB.
//   npx tsx src/lib/parlay/standard-generator-frozen-acceptance-test.ts
//   (re-freeze, only for an intended Standard change: add --write)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGeneratedParlay, type GeneratorSettings, type GeneratorSnapshot } from "@/lib/parlay/generator";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";
import type { CapperLeagueRecords } from "@/server/data/picks";

const NOW = new Date("2026-10-15T14:00:00.000Z");
const col = (wins: number, losses: number) => ({ wins, losses, pushes: 0, winPct: (wins / (wins + losses)) * 100, count: wins + losses });
const TEAMS: [string, string, string][] = [
  ["Kansas City Chiefs", "Los Angeles Chargers", "Chiefs"],
  ["Buffalo Bills", "Miami Dolphins", "Bills"],
  ["Philadelphia Eagles", "Dallas Cowboys", "Eagles"],
  ["Detroit Lions", "Chicago Bears", "Lions"],
  ["Baltimore Ravens", "Cincinnati Bengals", "Ravens"],
  ["San Francisco 49ers", "Seattle Seahawks", "49ers"],
];

function snapshot(): GeneratorSnapshot {
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const cappers: [string, [number, number]][] = [["fav", [14, 6]], ["over", [13, 7]], ["dog", [6, 14]], ["spread", [11, 4]]];
  const games: GeneratorGame[] = TEAMS.map(([home, away, nick], i) => {
    const gameTime = new Date(NOW.getTime() + (3 + i) * 3600_000).toISOString();
    const picks: GeneratorPick[] = [];
    const add = (capper: string, rec: [number, number], category: PickCategoryKey, betType: string, detail: string, line: number | null, odds: number) => {
      const r = col(...rec);
      categoryRecords[capper + "|" + category] = { key: category, label: category, ...r };
      leagueRecords.records[capper + "|NFL|" + category] = { category, label: category, overall: r, league: r };
      picks.push({
        pickId: `p-${i}-${capper}`, capperId: capper, capperName: "Capper " + capper, capperColorTag: null, capperIsFavorite: false, category,
        leagueName: "NFL", gameId: "g" + i, gameLabel: away + " @ " + home, betDetail: detail, odds, units: 1, status: "PENDING", betType, period: "FULL_GAME",
        rawBetDetail: detail, propMarket: null, line, homeTeam: home, awayTeam: away, gameTime, teamGroup: "HOME", teamLabel: "", teamColor: null,
        datePosted: new Date(NOW.getTime() - 2 * 3600_000).toISOString(), gameNumber: null,
      } as unknown as GeneratorPick);
    };
    add("fav", cappers[0][1], "FAV_ML", "MONEYLINE", nick + " ML", null, -150);
    add("over", cappers[1][1], "OVER", "TOTAL", "Over 44.5", 44.5, -110);
    add("dog", cappers[2][1], "DOG_ML", "MONEYLINE", away.split(" ").pop() + " ML", null, 130);
    add("spread", cappers[3][1], "SPREAD_MINUS", "SPREAD", nick + " -3", -3, -110);
    return { gameId: "g" + i, gameLabel: away + " @ " + home, gameTime, leagueName: "NFL", picks };
  });
  return { builtAt: NOW.toISOString(), games, slipPicks: [], targets: [], leagueRecords, categoryRecords };
}

const SETTINGS: [string, GeneratorSettings][] = [
  ["3 legs, best available", { legCount: 3, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" }],
  ["4 legs, 2 per game, game lines", { legCount: 4, maxLegsPerGame: 2, include: ["MONEYLINE", "SPREAD", "TOTALS"], mix: null, fillFrom: "BEST_AVAILABLE" }],
  ["2 legs, totals only, 60% gate", { legCount: 2, maxLegsPerGame: 1, include: ["TOTALS"], mix: null, fillFrom: "BEST_AVAILABLE", minWinPct: 60 }],
];

const produced = SETTINGS.map(([label, settings]) => [label, buildGeneratedParlay(snapshot(), settings, null, NOW)] as const);
const path = join(__dirname, "standard-generator-frozen.json");
// Plain JSON, with the key order the engine built it in.
const text = JSON.stringify(Object.fromEntries(produced), null, 2) + "\n";

if (process.argv.includes("--write")) {
  writeFileSync(path, text);
  console.log("frozen output written: " + path);
  process.exit(0);
}

const frozen = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
let failures = 0;
for (const [label, parlay] of produced) {
  const want = JSON.stringify(JSON.parse(frozen)[label]);
  const got = JSON.stringify(parlay);
  const pass = want === got;
  console.log(`${pass ? "PASS" : "FAIL"}: Standard output unchanged - ${label} (${parlay.legs.length} legs, hedge ${parlay.hedge.legs.length}, contrarian ${parlay.contrarian.legs.length})`);
  if (!pass) failures++;
}
const nonEmpty = produced.every(([, p]) => p.legs.length > 0);
console.log(`${nonEmpty ? "PASS" : "FAIL"}: every frozen case built at least one leg (a frozen empty parlay would prove nothing)`);
if (!nonEmpty) failures++;
console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures > 0 ? 1 : 0);
