// Pick.uniqueKey recompute rules (lib/pick-unique-key.ts). Pure (no database). Run with:
//   npx tsx src/lib/pick-unique-key-acceptance-test.ts
import { computeUniqueKey, mergedUniqueKey, touchesUniqueKey, withUniqueKey, UNIQUE_KEY_FIELDS } from "@/lib/pick-unique-key";
import { uniquePickKey, type UniquePickInput } from "@/lib/unique-picks";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const T = new Date("2026-11-15T18:00:00.000Z");
const T_REMATCHED = new Date("2026-11-16T00:15:00.000Z"); // late import re-matched to the night game

// Stored-row shapes (every column present, nulls explicit), one per key branch, incl. the text-parsed ones.
const STORED: UniquePickInput[] = [
  { id: "ml", status: "WIN", homeTeam: "Boston Celtics", awayTeam: "New York Knicks", gameTime: T, gameNumber: null, betType: "MONEYLINE", period: "FULL_GAME", betDetail: "Knicks ML -120", pickedSide: "AWAY", category: "FAV_ML", line: null, propMarket: null, playerName: null },
  { id: "ml-text", status: "LOSS", homeTeam: "Boston Celtics", awayTeam: "New York Knicks", gameTime: T, gameNumber: null, betType: "MONEYLINE", period: "FULL_GAME", betDetail: "Knicks ML", pickedSide: null, category: null, line: null, propMarket: null, playerName: null },
  { id: "sp", status: "PUSH", homeTeam: "Boston Celtics", awayTeam: "New York Knicks", gameTime: T, gameNumber: null, betType: "SPREAD", period: "FIRST_HALF", betDetail: "Celtics -4.5", pickedSide: "HOME", category: "FAV_SPREAD", line: -4.5, propMarket: null, playerName: null },
  { id: "tot", status: "PENDING", homeTeam: "Boston Celtics", awayTeam: "New York Knicks", gameTime: T, gameNumber: null, betType: "TOTAL", period: "FULL_GAME", betDetail: "o221.5", pickedSide: null, category: "GAME_TOTAL_OVER", line: 221.5, propMarket: null, playerName: null },
  { id: "tt", status: "WIN", homeTeam: "Boston Celtics", awayTeam: "New York Knicks", gameTime: T, gameNumber: null, betType: "TEAM_TOTAL", period: "FULL_GAME", betDetail: "Knicks TT under 108.5 -115", pickedSide: null, category: null, line: 108.5, propMarket: null, playerName: null },
  { id: "prop", status: "LOSS", homeTeam: "Boston Celtics", awayTeam: "New York Knicks", gameTime: T, gameNumber: null, betType: "PLAYER_PROP", period: "FULL_GAME", betDetail: "Jalen Brunson over 27.5 points (-110)", pickedSide: null, category: "PTS_PROP", line: null, propMarket: "POINTS", playerName: "Jalen  Brunson" },
  { id: "nrfi", status: "WIN", homeTeam: "New York Yankees", awayTeam: "Boston Red Sox", gameTime: T, gameNumber: 2, betType: "NRFI", period: "FIRST_INNING", betDetail: "NFRI", pickedSide: null, category: null, line: null, propMarket: null, playerName: null },
];

// 1. The stored key is exactly uniquePickKey of the row (no logic of its own).
for (const p of STORED) check(`computeUniqueKey == uniquePickKey (${p.id})`, computeUniqueKey(p) === uniquePickKey(p), computeUniqueKey(p) + " vs " + uniquePickKey(p));

// 2. Insert shape (optional columns omitted, period defaulted) keys the same as the stored row it becomes.
const insertShape = { homeTeam: "Boston Celtics", awayTeam: "New York Knicks", gameTime: T, betType: "MONEYLINE", betDetail: "Knicks ML -120", pickedSide: "AWAY", category: "FAV_ML" };
check("insert shape (omitted -> column defaults) == stored row's key", computeUniqueKey(insertShape) === uniquePickKey(STORED[0]));
check("withUniqueKey keeps the row and adds the key", (() => { const r = withUniqueKey({ ...insertShape, units: 2 }); return r.units === 2 && r.uniqueKey === uniquePickKey(STORED[0]); })());

// 3. Recompute on update: from the MERGED full row, never the partial patch.
const tt = STORED[4];
check("game re-match (gameTime) changes uniqueKey", mergedUniqueKey(tt, { gameTime: T_REMATCHED }) !== computeUniqueKey(tt));
check("...and equals the key of the full re-matched row", mergedUniqueKey(tt, { gameTime: T_REMATCHED }) === uniquePickKey({ ...tt, gameTime: T_REMATCHED }));
check("touchesUniqueKey: gameTime patch", touchesUniqueKey({ gameTime: T_REMATCHED }) === true);
check("status-only edit doesn't touch the key", touchesUniqueKey({ status: "WIN", gradedAt: new Date(), gradedViaFuzzyMatch: false }) === false);
check("status-only edit leaves uniqueKey unchanged", mergedUniqueKey(tt, { status: "LOSS" } as never) === computeUniqueKey(tt));
check("capperId (capper merge) doesn't touch the key", touchesUniqueKey({ capperId: "c2" }) === false);
check("undefined in a patch = unchanged (Prisma semantics)", mergedUniqueKey(tt, { gameTime: undefined, line: undefined }) === computeUniqueKey(tt) && !touchesUniqueKey({ line: undefined }));
check("category restamp on a TOTAL changes the key (over/under)", mergedUniqueKey(STORED[3], { category: "GAME_TOTAL_UNDER" }) !== computeUniqueKey(STORED[3]));
check("ML-side backfill (pickedSide on a text ML) changes the key", mergedUniqueKey(STORED[1], { pickedSide: "AWAY" }) !== computeUniqueKey(STORED[1]));
check("explicit null clears a field (line -> text fallback)", mergedUniqueKey(STORED[2], { line: null }) === uniquePickKey({ ...STORED[2], line: null }));

// 4. Every field in UNIQUE_KEY_FIELDS can move some key (so the list holds no dead entries).
const moves: Record<string, boolean> = {};
const probes: Record<string, [UniquePickInput, unknown]> = {
  homeTeam: [STORED[0], "Brooklyn Nets"],
  awayTeam: [STORED[0], "Miami Heat"],
  gameTime: [STORED[0], T_REMATCHED],
  gameNumber: [STORED[6], 1],
  period: [STORED[0], "FIRST_HALF"],
  betType: [STORED[0], "SPREAD"],
  betDetail: [STORED[1], "Celtics ML"],
  pickedSide: [STORED[0], "HOME"],
  category: [STORED[3], "GAME_TOTAL_UNDER"],
  line: [STORED[2], -5.5],
  propMarket: [STORED[5], "REBOUNDS"],
  playerName: [STORED[5], "Josh Hart"],
};
for (const f of UNIQUE_KEY_FIELDS) {
  const [row, v] = probes[f];
  moves[f] = mergedUniqueKey(row, { [f]: v }) !== computeUniqueKey(row);
}
check("every UNIQUE_KEY_FIELDS entry moves the key", Object.values(moves).every(Boolean), JSON.stringify(moves));

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
