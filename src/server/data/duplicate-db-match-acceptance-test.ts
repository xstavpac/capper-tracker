// Parity proof for the batched "already logged?" duplicate check
// (duplicate-db-match.ts) against the per-pick version it replaced in
// checkDuplicatePicksAction.
//
// LEGACY below is the old code path, kept verbatim in shape: for each pasted
// pick, the rows its own WHERE would have returned (user, capper, sport, home
// team, away team, game time within the drift window), then the same
// period / pickCategory / dedupCategory find. NEW is one superset read for the
// whole paste (existingPicksWhere) followed by dbDuplicateLabel per pick.
// Both run over the same in-memory table in the same row order, and must give
// the same label for every pasted pick.
//
// The table is built to contain every way the superset read is wider than a
// per-pick read: another user's rows, another capper's, the same team names in
// another sport, home/away swapped, a game just outside one pick's window but
// inside the paste's overall span, other periods, other sides, props.
//
// Pure: no database (the "table" is an array, the WHERE is evaluated here).
// Run with:
//   npx tsx src/server/data/duplicate-db-match-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { readFileSync } from "node:fs";
import type { Prisma } from "@prisma/client";
import { betTypeLabel } from "@/lib/bet-line";
import { dedupCategory } from "@/lib/duplicate-pick-detection";
import { pickCategory } from "@/server/data/stats";
import {
  EXISTING_PICK_SELECT,
  dbDuplicateLabel,
  existingPicksWhere,
  sportIdsByLowerName,
  type DbDupCandidate,
  type ExistingPickRow,
} from "@/server/data/duplicate-db-match";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const DRIFT = 6 * 3600_000;
const H = 3600_000;
const T0 = Date.UTC(2026, 9, 10, 23, 0, 0);

type TableRow = ExistingPickRow & { id: string; userId: string };

let nextId = 1;
function row(over: Partial<TableRow>): TableRow {
  return {
    id: "p" + String(nextId++).padStart(4, "0"),
    userId: "u1",
    capperId: "c1",
    sportId: "mlb",
    homeTeam: "Chicago Cubs",
    awayTeam: "Los Angeles Dodgers",
    gameTime: new Date(T0),
    period: "FULL_GAME",
    betType: "MONEYLINE",
    betDetail: "Cubs ML",
    odds: -130,
    line: null,
    pickedSide: "HOME",
    mlFavoredSide: "HOME",
    propMarket: null,
    playerName: null,
    ...over,
  } as TableRow;
}

const SPORT_NAME: Record<string, string> = { mlb: "MLB", nfl: "NFL", ncaaf: "NCAAF" };

// The logged picks. Order matters (first match supplies the label), so it is
// fixed here and both paths read it in this order.
const TABLE: TableRow[] = [
  // Plain matches.
  row({ betDetail: "Cubs ML" }),
  row({ betType: "SPREAD", betDetail: "Cubs -1.5", line: -1.5, odds: 140 }),
  row({ betType: "TOTAL", betDetail: "Over 8.5", line: 8.5, odds: -110, pickedSide: null, mlFavoredSide: null }),
  // Same bet logged twice: the label must come from the first.
  row({ betDetail: "Cubs moneyline (second copy)" }),
  // Empty betDetail: label falls back to the bet type's label.
  row({ homeTeam: "Seattle Mariners", awayTeam: "Houston Astros", betDetail: null }),
  // Traps the superset read returns but a per-pick read never did.
  row({ userId: "u2", betDetail: "another user's Cubs ML" }),
  row({ capperId: "c2", betDetail: "another capper's Cubs ML" }),
  row({ sportId: "nfl", betDetail: "same team names, other sport" }),
  row({ homeTeam: "Los Angeles Dodgers", awayTeam: "Chicago Cubs", betDetail: "home/away swapped", pickedSide: "AWAY" }),
  row({ gameTime: new Date(T0 + DRIFT + 1), betDetail: "next day's game, 1 ms outside the window" }),
  row({ gameTime: new Date(T0 - DRIFT), betType: "SPREAD", betDetail: "Cubs +1.5 at the window edge", line: 1.5, odds: -160 }),
  row({ period: "FIRST_HALF", betDetail: "Cubs F5 ML" }),
  row({ betDetail: "Dodgers ML", pickedSide: "AWAY", odds: 110 }),
  // A second game later in the same paste's span (widens the superset range).
  row({ homeTeam: "New York Yankees", awayTeam: "Boston Red Sox", gameTime: new Date(T0 + 20 * H), betDetail: "Yankees ML" }),
  row({
    homeTeam: "New York Yankees",
    awayTeam: "Boston Red Sox",
    gameTime: new Date(T0 + 20 * H),
    betType: "TEAM_TOTAL",
    betDetail: "Yankees team total over 4.5",
    line: 4.5,
    odds: -115,
  }),
  // NFL, other capper: quarter total vs full-game total, and props.
  row({ capperId: "c2", sportId: "nfl", homeTeam: "Detroit Lions", awayTeam: "Buffalo Bills", gameTime: new Date(T0 + 44 * H), betType: "TOTAL", betDetail: "Over 47.5", line: 47.5, odds: -110, pickedSide: null, mlFavoredSide: null }),
  row({ capperId: "c2", sportId: "nfl", homeTeam: "Detroit Lions", awayTeam: "Buffalo Bills", gameTime: new Date(T0 + 44 * H), betType: "TOTAL", period: "FIRST_QUARTER", betDetail: "Over 10.5 1Q", line: 10.5, odds: -110, pickedSide: null, mlFavoredSide: null }),
  row({ capperId: "c2", sportId: "nfl", homeTeam: "Detroit Lions", awayTeam: "Buffalo Bills", gameTime: new Date(T0 + 44 * H), betType: "PLAYER_PROP", betDetail: "Jared Goff Over 250.5 Passing Yards", line: 250.5, odds: -115, pickedSide: null, mlFavoredSide: null, propMarket: "PASS_YDS", playerName: "Jared Goff" }),
  // A legacy prop row with no stored market/player: dedupCategory re-parses the text.
  row({ capperId: "c2", sportId: "nfl", homeTeam: "Detroit Lions", awayTeam: "Buffalo Bills", gameTime: new Date(T0 + 44 * H), betType: "PLAYER_PROP", betDetail: "Josh Allen Over 1.5 Passing TDs", line: 1.5, odds: 120, pickedSide: null, mlFavoredSide: null }),
];

// ---- LEGACY: the per-pick read + find, as checkDuplicatePicksAction did it ----
function legacyLabel(userId: string, c: DbDupCandidate): string | null {
  const existingPicks = TABLE.filter(
    (p) =>
      p.userId === userId &&
      p.capperId === c.capperId &&
      p.sportId === c.sportId &&
      p.homeTeam === c.homeTeam &&
      p.awayTeam === c.awayTeam &&
      p.gameTime.getTime() >= c.gameTimeMs - DRIFT &&
      p.gameTime.getTime() <= c.gameTimeMs + DRIFT
  );
  const dbDup = existingPicks.find((p) => {
    if (p.period !== c.period) return false;
    const pCategory = pickCategory({ ...p, sportName: c.sportName });
    if (!pCategory) return false;
    const knownPlayerProp = p.propMarket && p.playerName ? { propMarket: p.propMarket, playerName: p.playerName } : null;
    return dedupCategory(pCategory, p.betType, p.betDetail, p.pickedSide, knownPlayerProp) === c.dedupKey;
  });
  return dbDup ? dbDup.betDetail || betTypeLabel(dbDup.betType) : null;
}

// ---- NEW: one superset read (the WHERE evaluated in memory), then per-pick match ----
function evalWhere(where: Prisma.PickWhereInput): ExistingPickRow[] {
  const capperIds = (where.capperId as { in: string[] }).in;
  const sportIds = (where.sportId as { in: string[] }).in;
  const range = where.gameTime as { gte: Date; lte: Date };
  return TABLE.filter(
    (p) =>
      p.userId === where.userId &&
      capperIds.includes(p.capperId) &&
      sportIds.includes(p.sportId) &&
      p.gameTime.getTime() >= range.gte.getTime() &&
      p.gameTime.getTime() <= range.lte.getTime()
  );
}

// Every pasted-pick shape, derived from the table itself (each logged row
// becomes "the same bet pasted again") plus hand-written near misses.
function candidateFromRow(p: TableRow): DbDupCandidate | null {
  const sportName = SPORT_NAME[p.sportId];
  const category = pickCategory({ ...p, sportName });
  if (!category) return null;
  const known = p.propMarket && p.playerName ? { propMarket: p.propMarket, playerName: p.playerName } : null;
  return {
    capperId: p.capperId,
    sportId: p.sportId,
    sportName,
    homeTeam: p.homeTeam,
    awayTeam: p.awayTeam,
    gameTimeMs: p.gameTime.getTime(),
    period: p.period,
    dedupKey: dedupCategory(category, p.betType, p.betDetail, p.pickedSide, known),
  };
}

const fromRows = TABLE.map(candidateFromRow).filter((c): c is DbDupCandidate => c !== null);
const base = fromRows[0];
const nearMisses: DbDupCandidate[] = [
  { ...base, capperId: "c3" }, // a capper with nothing logged
  { ...base, sportId: "ncaaf", sportName: "NCAAF" }, // a sport with nothing logged
  { ...base, homeTeam: "Chicago White Sox" },
  { ...base, awayTeam: "San Diego Padres" },
  { ...base, gameTimeMs: T0 + DRIFT }, // exactly at the edge of the first rows' window
  { ...base, gameTimeMs: T0 + DRIFT + 1 }, // 1 ms past it - but inside the next-day row's window
  { ...base, gameTimeMs: T0 + 3 * DRIFT },
  { ...base, period: "SECOND_HALF" },
  { ...base, dedupKey: "DOG_ML" },
  { ...base, dedupKey: "SOMETHING_ELSE" },
  // Time-shifted copies of every row-derived candidate, both directions.
  ...fromRows.map((c) => ({ ...c, gameTimeMs: c.gameTimeMs + 2 * H })),
  ...fromRows.map((c) => ({ ...c, gameTimeMs: c.gameTimeMs - DRIFT - 1 })),
];
const candidates = [...fromRows, ...nearMisses];

function main() {
  // 1. Whole-paste parity for user u1, and again for u2 (who has one row).
  for (const userId of ["u1", "u2"]) {
    const where = existingPicksWhere(userId, candidates, DRIFT)!;
    const rows = evalWhere(where);
    const legacy = candidates.map((c) => legacyLabel(userId, c));
    const batched = candidates.map((c) => dbDuplicateLabel(rows, c, DRIFT));
    expect(`${userId}: batched labels === per-pick labels for ${candidates.length} pasted picks`, batched, legacy);
    expect(`${userId}: the fixture actually exercises matches`, legacy.filter((l) => l !== null).length > (userId === "u1" ? 10 : 0), true);
    expect(`${userId}: and non-matches`, legacy.filter((l) => l === null).length > 10, true);
  }

  // 2. Parity for every sub-paste too: the superset range depends on which
  //    picks are in the paste, so each pick must match on its own, in pairs,
  //    and in a sliding window.
  {
    let mismatches = 0;
    let checked = 0;
    const subsets: DbDupCandidate[][] = [];
    for (let i = 0; i < candidates.length; i++) {
      subsets.push([candidates[i]]);
      subsets.push([candidates[i], candidates[(i * 7 + 3) % candidates.length]]);
      subsets.push(candidates.slice(i, i + 5));
    }
    for (const subset of subsets) {
      const where = existingPicksWhere("u1", subset, DRIFT)!;
      const rows = evalWhere(where);
      for (const c of subset) {
        checked++;
        if (dbDuplicateLabel(rows, c, DRIFT) !== legacyLabel("u1", c)) mismatches++;
      }
    }
    expect(`sub-paste parity across ${subsets.length} pastes / ${checked} picks`, mismatches, 0);
  }

  // 3. Spot checks on the cases the batching could have broken.
  {
    const rows = evalWhere(existingPicksWhere("u1", candidates, DRIFT)!);
    expect("first logged copy supplies the label", dbDuplicateLabel(rows, base, DRIFT), "Cubs ML");
    expect("another capper's identical pick is not a duplicate", dbDuplicateLabel(rows, { ...base, capperId: "c3" }, DRIFT), null);
    expect("same team names in another sport is not a duplicate", dbDuplicateLabel(rows, { ...base, sportId: "ncaaf", sportName: "NCAAF" }, DRIFT), null);
    expect(
      "a row outside this pick's own window is ignored even though the read returned it",
      dbDuplicateLabel(rows, { ...base, gameTimeMs: T0 - 2 * DRIFT - 2 }, DRIFT),
      null
    );
    expect("null betDetail falls back to the bet type label", dbDuplicateLabel(rows, candidateFromRow(TABLE[4])!, DRIFT), betTypeLabel("MONEYLINE"));
    expect("the superset read returned rows a per-pick read would not", rows.length > 3, true);
  }

  // 4. The WHERE itself.
  {
    expect("no candidates -> no read", existingPicksWhere("u1", [], DRIFT), null);
    const where = existingPicksWhere(
      "u1",
      [
        { capperId: "c1", sportId: "mlb", gameTimeMs: T0 },
        { capperId: "c1", sportId: "nfl", gameTimeMs: T0 + 44 * H },
        { capperId: "c2", sportId: "mlb", gameTimeMs: T0 - 5 * H },
      ],
      DRIFT
    )!;
    expect("scoped to the user", where.userId, "u1");
    expect("distinct capper ids", (where.capperId as { in: string[] }).in, ["c1", "c2"]);
    expect("distinct sport ids", (where.sportId as { in: string[] }).in, ["mlb", "nfl"]);
    const range = where.gameTime as { gte: Date; lte: Date };
    expect("range starts at earliest game - drift", range.gte.getTime(), T0 - 5 * H - DRIFT);
    expect("range ends at latest game + drift", range.lte.getTime(), T0 + 44 * H + DRIFT);
  }

  // 5. Sport ids: case-insensitive, first row (by id order) wins.
  {
    const m = sportIdsByLowerName([
      { id: "s1", name: "MLB" },
      { id: "s2", name: "mlb" },
      { id: "s3", name: "NFL" },
    ]);
    expect("sport ids by lower-cased name", [m.get("mlb"), m.get("nfl"), m.get("nhl") ?? null], ["s1", "s3", null]);
  }

  // 6. Source inspection: the action issues the batched statements, not per-pick ones.
  {
    const src = readFileSync("src/server/actions/bulk-picks.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function checkDuplicatePicksAction"), src.indexOf("type CapperRef = "));
    expect("one pick read in the action", (fn.match(/prisma\.pick\.findMany\(/g) ?? []).length, 1);
    expect("one sport read in the action", (fn.match(/prisma\.sport\.find/g) ?? []).length, 1);
    expect("the sport read is a findMany (no per-name findFirst)", /prisma\.sport\.findFirst/.test(fn), false);
    const mapStart = fn.indexOf("items.map(async");
    const mapEnd = fn.indexOf("// Phase 2");
    expect("no database call inside the per-item resolution", /prisma\./.test(fn.slice(mapStart, mapEnd)), false);
    expect("the pick read is ordered, so the label is deterministic", /select: EXISTING_PICK_SELECT, orderBy: \{ id: "asc" \}/.test(fn), true);
    expect(
      "the select covers every column the match reads",
      Object.keys(EXISTING_PICK_SELECT).sort(),
      ["awayTeam", "betDetail", "betType", "capperId", "gameTime", "homeTeam", "line", "mlFavoredSide", "odds", "period", "pickedSide", "playerName", "propMarket", "sportId"]
    );
  }

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll passed");
  process.exit(0);
}

main();
