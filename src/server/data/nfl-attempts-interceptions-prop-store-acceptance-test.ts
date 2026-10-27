// NFL attempts / completions / interceptions markets: import -> STORE -> grade against the real database.
// The import half (parseCatalog -> the stored columns bulkImportPicksAction derives) and the grading half are
// covered without a database in nfl-attempts-interceptions-prop-parsing-acceptance-test.ts; this pins the part
// only a real Postgres can: the four new PropMarket enum values insert through createPicksWithEntitlementCheck
// (the import's own insert path, which stamps the category), read back intact, and the row as read back grades
// against a saved real ESPN box score.
//
// Real-database test, run with DATABASE_URL set (needs migration 20261028000000 applied):
//   npx tsx src/server/data/nfl-attempts-interceptions-prop-store-acceptance-test.ts
import fs from "node:fs";
import path from "node:path";
import type { PropMarket } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseCatalog } from "@/lib/parse-catalog";
import { parseAnyPlayerProp } from "@/lib/bet-line";
import { PICK_CATEGORY_VERSION } from "@/server/data/stats";
import { createPicksWithEntitlementCheck, type PickInsertData } from "@/server/data/subscriptions";
import { resolvePlayerProp, GRADING_PICK_SELECT } from "@/server/data/grading";
import type { RosterPlayer } from "@/server/data/nfl-roster";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} - expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

const TAG = `nfl-att-int-${Date.now()}`;
const load = (file: string): any => JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", file), "utf8"));
const ROSTER: RosterPlayer[] = [
  { externalPlayerId: "8439", playerName: "Aaron Rodgers", firstName: "Aaron", lastName: "Rodgers", team: "Pittsburgh Steelers", position: "QB" },
];

// [raw line, game, expected stored market, expected category, expected outcome]
const CASES = [
  ["Sam Darnold over 0.5 interceptions", { id: "401873022", file: "nfl-boxscore-401873022-kc-sea.json", home: "Seattle Seahawks", away: "Kansas City Chiefs" }, "PASS_INTERCEPTIONS", "PASS_INTERCEPTIONS_PROP", "WIN"],
  ["Rodgers Over 34.5 Pass Attempts", { id: "401872658", file: "nfl-boxscore-401872658-pit-atl.json", home: "Atlanta Falcons", away: "Pittsburgh Steelers" }, "PASS_ATTEMPTS", "PASS_ATTEMPTS_PROP", "WIN"],
  ["Sam Darnold over 20 completions", { id: "401873022", file: "nfl-boxscore-401873022-kc-sea.json", home: "Seattle Seahawks", away: "Kansas City Chiefs" }, "PASS_COMPLETIONS", "PASS_COMPLETIONS_PROP", "PUSH"],
  ["JK Dobbins over 13.5 rushing attempts", { id: "401873019", file: "nfl-boxscore-401873019-den-ari.json", home: "Arizona Cardinals", away: "Denver Broncos" }, "RUSH_ATTEMPTS", "RUSH_ATTEMPTS_PROP", "LOSS"],
] as const;

async function main() {
  const userIds: string[] = [];
  const createdSports: string[] = [];
  try {
    const u = await prisma.user.create({ data: { supabaseId: TAG, email: `${TAG}@example.test` } });
    userIds.push(u.id);
    await prisma.subscription.create({ data: { userId: u.id, plan: "BASIC", status: "active" } });
    const capper = await prisma.capper.create({ data: { userId: u.id, name: "cap-" + TAG, source: "OTHER" } });
    let nfl = await prisma.sport.findFirst({ where: { name: "NFL" }, select: { id: true } });
    if (!nfl) {
      nfl = await prisma.sport.create({ data: { name: "NFL" }, select: { id: true } });
      createdSports.push(nfl.id);
    }

    // Import: the parsed item and the prop columns exactly as bulkImportPicksAction derives them.
    const rows: PickInsertData[] = CASES.map(([raw, game], i) => {
      const item = parseCatalog("Capper\nNFL " + raw, ["Capper"]).picks[0];
      const prop = parseAnyPlayerProp(item.description, item.sportName);
      return {
        capperId: capper.id,
        sportId: nfl!.id,
        homeTeam: game.home,
        awayTeam: game.away,
        betType: item.betType,
        betDetail: item.description,
        odds: -110,
        period: item.period,
        units: 1,
        gameTime: new Date(Date.UTC(2026, 9, 26, 17, i)),
        playerName: prop?.playerName,
        propMarket: prop?.propMarket as PropMarket | undefined,
      };
    });

    // Store.
    const res = await createPicksWithEntitlementCheck(u.id, rows);
    check("insert allowed", res.allowed, true);
    const ids = res.allowed ? res.created.map((c) => c.id) : [];
    check("one row per case", ids.length, CASES.length);

    // Read back + grade the row as stored.
    const stored = await prisma.pick.findMany({ where: { id: { in: ids } }, select: { ...GRADING_PICK_SELECT, category: true, categoryVersion: true } });
    const byId = new Map(stored.map((p) => [p.id, p]));
    for (let i = 0; i < CASES.length; i++) {
      const [raw, game, market, category, outcome] = CASES[i];
      const p = byId.get(ids[i]);
      check(`stored row: "${raw}"`, p ? [p.betType, p.propMarket, p.category, p.categoryVersion] : null, ["PLAYER_PROP", market, category, PICK_CATEGORY_VERSION]);
      if (!p) continue;
      const graded = await resolvePlayerProp(p, game.id, "NFL", { fetchSummary: async () => load(game.file), getRoster: async () => ROSTER });
      check(`graded from the stored row: "${raw}"`, graded.outcome, outcome);
    }
  } finally {
    // Picks and the capper cascade from the user.
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    if (createdSports.length) await prisma.sport.deleteMany({ where: { id: { in: createdSports } } });
  }
}

main()
  .catch((err) => {
    console.error("FAIL: unexpected error", err);
    failures++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  });
