// Proof for Auto-Generate's Primary + alternates and the no-repeat Regenerate
// (lib/parlay/alternates.ts). Pure - no DB; the random source is seeded so
// every run is the same. Run with:
//   npx tsx src/lib/parlay/alternates-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_SLIP,
  NO_MORE_DISTINCT,
  buildParlaySet,
  gameShortlist,
  legDifference,
  legSetKey,
  lockParlay,
  minLegDifference,
  type ParlaySet,
  type Rng,
  type SlipHint,
} from "@/lib/parlay/alternates";
import { buildAutoParlay, type AutoParlay, type GeneratorGame } from "@/lib/parlay/auto-generate";
import { blocks } from "@/lib/parlay/build-my-picks";
import { toBuildCandidate } from "@/lib/parlay/pool-swap";
import { classifyPickKind } from "@/lib/parlay/pick-kind";
import { FROZEN_GAMES, FROZEN_LEAGUE_RECORDS, FROZEN_LEG_COUNTS } from "@/lib/parlay/auto-generate-frozen-fixture";
import { slateGame, slatePick, slateRecords, GAMES, type Bet, type GameKey } from "@/lib/parlay/__fixtures__/slip-slate";
import type { CapperLeagueRecords } from "@/server/data/picks";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

function seeded(seed: number): Rng {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const legIds = (p: AutoParlay) => p.legs.map((l) => l.top.pick.pickId);

// A slate with many valid combinations: five games, four picks each (both
// moneylines and both sides of the total), records 40-85%.
const BETS: Bet[] = ["HOME", "AWAY", "OVER", "UNDER"];
const KEYS = Object.keys(GAMES) as GameKey[];
const pct: Record<string, number> = {};
const SLATE: GeneratorGame[] = KEYS.map((g, gi) =>
  slateGame(
    g,
    BETS.map((bet, bi) => {
      const id = g + bet;
      pct[id] = 85 - ((gi * 4 + bi * 7) % 10) * 5;
      return slatePick(id, g, bet);
    })
  )
);
const RECORDS = slateRecords(pct);

function generate(over: { games?: GeneratorGame[]; records?: CapperLeagueRecords; legCount?: number; slip?: SlipHint; exclude?: string[]; seed?: number; mix?: number | null } = {}) {
  const games = over.games ?? SLATE;
  const records = over.records ?? RECORDS;
  const slip = over.slip ?? EMPTY_SLIP;
  const primary = lockParlay(buildAutoParlay(games, records, over.legCount ?? 4, over.mix ?? null), games, records, slip);
  if ("error" in primary) throw new Error(primary.error);
  const set = buildParlaySet({
    games,
    records,
    slip,
    primary,
    includePrimary: over.exclude === undefined,
    count: 3,
    exclude: new Set(over.exclude ?? []),
    extraLegs: () => [],
    rng: seeded(over.seed ?? 1),
  });
  return { primary, set };
}

function checkSetRules(label: string, set: ParlaySet, legCount: number) {
  const need = minLegDifference(legCount);
  let closest = Infinity;
  for (let i = 0; i < set.parlays.length; i++) {
    for (let j = i + 1; j < set.parlays.length; j++) closest = Math.min(closest, legDifference(legIds(set.parlays[i]), legIds(set.parlays[j])));
  }
  check(`${label}: every pair differs by at least ${need} leg(s)`, set.parlays.length < 2 || closest >= need, true);
  let badPairs = 0;
  let repeatedGames = 0;
  for (const p of set.parlays) {
    const games = p.legs.map((l) => l.gameId);
    if (new Set(games).size !== games.length) repeatedGames++;
    for (let i = 0; i < p.legs.length; i++) {
      for (let j = i + 1; j < p.legs.length; j++) if (blocks(toBuildCandidate(p.legs[i].top.pick), toBuildCandidate(p.legs[j].top.pick)).blocked) badPairs++;
    }
  }
  check(`${label}: one leg per game in every parlay`, repeatedGames, 0);
  check(`${label}: no conflicting or duplicate pair in any parlay`, badPairs, 0);
}

// Quiet version of checkSetRules for the many regenerate rounds.
let quietFailures = 0;
function checkSetRulesQuiet(set: ParlaySet, legCount: number) {
  const need = minLegDifference(legCount);
  for (let i = 0; i < set.parlays.length; i++) {
    const p = set.parlays[i];
    if (new Set(p.legs.map((l) => l.gameId)).size !== p.legs.length) quietFailures++;
    for (let j = i + 1; j < set.parlays.length; j++) if (legDifference(legIds(p), legIds(set.parlays[j])) < need) quietFailures++;
  }
}

// ============================================================================
// First Generate: the Primary is today's Parlay A, then two alternates.
// ============================================================================
{
  const { primary, set } = generate({ legCount: 4 });
  check("4 legs: three parlays", set.parlays.length, 3);
  check("4 legs: not exhausted", set.exhausted, false);
  check("4 legs: the first is the Primary, untouched", set.parlays[0] === primary, true);
  check("4 legs: alternates have the Primary's leg count", set.parlays.map((p) => p.legs.length), [4, 4, 4]);
  checkSetRules("4 legs", set, 4);
  check("4 legs: each alternate differs from the Primary by 2+", set.parlays.slice(1).every((p) => legDifference(legIds(p), legIds(primary)) >= 2), true);
}
{
  const { set } = generate({ legCount: 3 });
  check("3 legs: three parlays", set.parlays.length, 3);
  checkSetRules("3 legs (1+ leg difference)", set, 3);
}
{
  // Alternates draw from each game's shortlist - never outside it.
  const { set } = generate({ legCount: 5, seed: 9 });
  const shortlisted = new Set(SLATE.flatMap((g) => gameShortlist(g, RECORDS, new Set()).map((r) => r.pick.pickId)));
  check("alternates only use shortlisted picks", set.parlays.every((p) => legIds(p).every((id) => shortlisted.has(id))), true);
  // Rotation: across a few seeds the alternates use games and picks Parlay A doesn't.
  const primaryIds = new Set(legIds(set.parlays[0]));
  const altIds = new Set(set.parlays.slice(1).flatMap(legIds));
  check("alternates bring in picks the Primary doesn't have", [...altIds].some((id) => !primaryIds.has(id)), true);
}

// ============================================================================
// Empty slip: the Primary is byte-for-byte today's frozen Parlay A.
// ============================================================================
{
  const frozenText = readFileSync(join(__dirname, "auto-generate-frozen-parlay-a.json"), "utf8").replace(/\r\n/g, "\n");
  const now: Record<string, unknown> = {};
  for (const n of FROZEN_LEG_COUNTS) {
    const { set } = generate({ games: FROZEN_GAMES, records: FROZEN_LEAGUE_RECORDS, legCount: n });
    now["requested" + n] = set.parlays[0];
  }
  check("empty slip: the Primary for 3 / 5 / 20 legs is byte-for-byte the frozen Parlay A", JSON.stringify(now, null, 2) + "\n" === frozenText, true);
  const a = buildAutoParlay(SLATE, RECORDS, 4);
  check("empty slip: lockParlay hands Parlay A back as is", lockParlay(a, SLATE, RECORDS, EMPTY_SLIP) === a, true);
}

// ============================================================================
// Regenerate: three new parlays, never a leg set shown before; then the message.
// ============================================================================
{
  const first = generate({ legCount: 3, seed: 3 }).set;
  const shown = first.parlays.map((p) => legSetKey(legIds(p)));
  let rounds = 0;
  let repeats = 0;
  let lastRound: ParlaySet = first;
  while (rounds < 40) {
    rounds++;
    const next = generate({ legCount: 3, exclude: shown, seed: 100 + rounds }).set;
    lastRound = next;
    checkSetRulesQuiet(next, 3);
    for (const p of next.parlays) {
      const key = legSetKey(legIds(p));
      if (shown.includes(key)) repeats++;
      shown.push(key);
    }
    if (next.parlays.length === 0) break;
  }
  check("regenerate: a round never repeats a leg set shown earlier", repeats, 0);
  check("regenerate: every leg set shown is distinct", new Set(shown).size, shown.length);
  check("regenerate: the Primary is never returned again", lastRound.parlays.some((p) => legSetKey(legIds(p)) === shown[0]), false);
  check("regenerate: a round's rules held every time", quietFailures, 0);
  check("regenerate: rounds ran before running out", rounds > 3, true);
}
{
  // Regenerate returns three when three are left.
  const first = generate({ legCount: 4 }).set;
  const next = generate({ legCount: 4, exclude: first.parlays.map((p) => legSetKey(legIds(p))), seed: 2 }).set;
  check("regenerate: three new parlays", next.parlays.length, 3);
  check("regenerate: the Primary isn't one of them", next.parlays.some((p) => legSetKey(legIds(p)) === legSetKey(legIds(first.parlays[0]))), false);
  checkSetRules("regenerate set", next, 4);
}

// ============================================================================
// Exhausted: only one combination exists.
// ============================================================================
{
  const tiny = [slateGame("G1", [slatePick("only1", "G1", "HOME")]), slateGame("G2", [slatePick("only2", "G2", "HOME")])];
  const records = slateRecords({ only1: 60, only2: 60 });
  const first = generate({ games: tiny, records, legCount: 2 }).set;
  check("exhausted: a first Generate still shows the Primary", first.parlays.map(legIds), [["only1", "only2"]]);
  check("exhausted: and says there is nothing more", first.exhausted, true);
  const again = generate({ games: tiny, records, legCount: 2, exclude: first.parlays.map((p) => legSetKey(legIds(p))) }).set;
  check("exhausted: Regenerate returns nothing rather than a repeat", [again.parlays.length, again.exhausted], [0, true]);
  check("exhausted: the message", NO_MORE_DISTINCT, "No more distinct parlays with these settings");
}

// ============================================================================
// Locks: in the Primary and in every alternate.
// ============================================================================
{
  // G5's lowest-ranked pick, locked: Parlay A wouldn't have it.
  const g5 = SLATE.find((g) => g.gameId === "G5")!;
  const weakest = [...g5.picks].sort((a, b) => pct[a.pickId] - pct[b.pickId])[0];
  const slip: SlipHint = { picks: [{ pickId: weakest.pickId, locked: true }], games: [{ gameId: "G3", locked: true }] };
  const { primary, set } = generate({ legCount: 3, slip, seed: 5 });
  check("locks: the locked pick is a Primary leg", legIds(primary).includes(weakest.pickId), true);
  check("locks: the locked game is in the Primary", primary.legs.some((l) => l.gameId === "G3"), true);
  check("locks: the Primary keeps its leg count", primary.legs.length, 3);
  check("locks: every alternate has the locked pick", set.parlays.every((p) => legIds(p).includes(weakest.pickId)), true);
  check("locks: every alternate has a leg from the locked game", set.parlays.every((p) => p.legs.some((l) => l.gameId === "G3")), true);
  check("locks: legs are marked locked", primary.legs.filter((l) => l.locked).map((l) => l.gameId).sort(), ["G3", "G5"]);
  checkSetRules("locks", set, 3);
}
{
  const g1 = SLATE.find((g) => g.gameId === "G1")!;
  const home = g1.picks.find((p) => p.betDetail.endsWith("Yankees ML"))!;
  const away = g1.picks.find((p) => p.betDetail.endsWith("Red Sox ML"))!;
  const r = lockParlay(buildAutoParlay(SLATE, RECORDS, 3), SLATE, RECORDS, {
    picks: [{ pickId: home.pickId, locked: true }, { pickId: away.pickId, locked: true }],
    games: [],
  });
  check("locks: conflicting locked picks -> an error naming both", "error" in r ? r.error : null, `Locked picks Capper ${home.pickId} — Yankees ML and Capper ${away.pickId} — Red Sox ML conflict - unlock one.`);
  const gone = lockParlay(buildAutoParlay(SLATE, RECORDS, 3), SLATE, RECORDS, { picks: [{ pickId: "nope", locked: true }], games: [{ gameId: "GX", locked: true }] });
  check("locks: a locked item not in these games -> an error listing it", "error" in gone ? gone.missing : null, ["nope", "game:GX"]);
  const tooMany = lockParlay(buildAutoParlay(SLATE, RECORDS, 1), SLATE, RECORDS, { picks: [], games: [{ gameId: "G1", locked: true }, { gameId: "G2", locked: true }] });
  check("locks: more locks than legs -> an error", "error" in tooMany ? tooMany.error : null, "2 slip items are locked, but the parlay is only 1 leg - unlock some or add legs.");
}

// ============================================================================
// Slip picks join their game's shortlist; a Pick Mix split is kept.
// ============================================================================
{
  const deep = slateGame("G1", ["HOME", "AWAY", "OVER", "UNDER"].map((b) => slatePick("d" + b, "G1", b as Bet)).concat([slatePick("dExtra", "G1", "HOME")]));
  const recs = slateRecords({ dHOME: 80, dAWAY: 75, dOVER: 70, dUNDER: 65, dExtra: 30 });
  check("shortlist: top pick + next 3, no slip", gameShortlist(deep, recs, new Set()).map((r) => r.pick.pickId), ["dHOME", "dAWAY", "dOVER", "dUNDER"]);
  check("shortlist: a slip pick below them joins", gameShortlist(deep, recs, new Set(["dExtra"])).map((r) => r.pick.pickId), ["dHOME", "dAWAY", "dOVER", "dUNDER", "dExtra"]);
}
{
  // Every game also has a player prop, so a 50% mix of 4 legs is 2 + 2.
  const prop = (g: GameKey, n: number) => ({
    ...slatePick(g + "prop" + n, g, "OVER"),
    betType: "PLAYER_PROP",
    betDetail: `Player ${g}${n} Over 1.5 Hits`,
    rawBetDetail: `Player ${g}${n} Over 1.5 Hits`,
    line: 1.5,
  });
  const mixed = SLATE.map((g, gi) => ({ ...g, picks: [...g.picks, prop(g.gameId as GameKey, 1), prop(g.gameId as GameKey, 2)] }));
  const mixedPct = { ...pct };
  KEYS.forEach((g, gi) => {
    mixedPct[g + "prop1"] = 80 - gi * 5;
    mixedPct[g + "prop2"] = 60 - gi * 5;
  });
  const recs = slateRecords(mixedPct);
  const { primary, set } = generate({ games: mixed, records: recs, legCount: 4, mix: 50, seed: 4 });
  const split = (p: AutoParlay) => p.legs.filter((l) => classifyPickKind(l.top.pick) === "PROP").length;
  check("mix: the Primary is 2 props + 2 game lines", split(primary), 2);
  check("mix: three parlays", set.parlays.length, 3);
  check("mix: every alternate keeps 2 props", set.parlays.map(split), [2, 2, 2]);
  checkSetRules("mix", set, 4);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
if (failures > 0) process.exit(1);
