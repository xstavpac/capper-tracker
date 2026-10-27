// Consensus Hybrid's generate flow (hybrid-generate.ts) and its exact-line
// handoff server half (hybrid-fanduel-link.ts), with every read faked: the
// snapshot loader, the ladder cache, the recent swings. No database, no network.
// The ladders are the real FanDuel capture lib/parlay/__fixtures__/fanduel-event-nfl.json
// (Denver Broncos vs Seattle Seahawks), served under many event ids.
//
// Pinned: the order of the reads (snapshot, then ladders for the candidate
// events only, then swings, then the optimizer), the markets asked per event
// (h2h only with moneyline supporters), targeted games restricting the events,
// Include Picks restricting the markets, the empty slip, the availability notes,
// and the result passed through as the optimizer made it. Run with:
//   npx tsx src/server/data/hybrid-generate-acceptance-test.ts
import nflEvent from "@/lib/parlay/__fixtures__/fanduel-event-nfl.json";
import { buildConsensusPositions } from "@/lib/parlay/consensus";
import { optimizeHybrid, HYBRID_CANDIDATE_GAMES } from "@/lib/parlay/hybrid";
import type { HybridGenerateRequest } from "@/lib/parlay/hybrid-request";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import type { GeneratorSnapshot } from "@/lib/parlay/generator";
import type { SwingGame } from "@/lib/parlay/recent-swings";
import type { CategoryBreakdownItem, PickCategoryKey } from "@/server/data/stats";
import type { CapperLeagueRecords } from "@/server/data/picks";
import type { AltLadder, AltLadderLookup, AltLadderRequest } from "@/server/data/alt-ladders";
import {
  ALT_LINES_NOT_POSTED_NOTE,
  chooseCandidateEvents,
  PRICING_IN_PROGRESS_NOTE,
  runHybridGenerate,
  type HybridDeps,
  type HybridGenerateResponse,
} from "@/server/data/hybrid-generate";
import { buildHybridFanDuelLink } from "@/server/data/hybrid-fanduel-link";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const NOW = new Date("2026-10-15T14:00:00.000Z");
const START = "2026-10-16T00:15:00.000Z";
const HOME = nflEvent.home_team; // Denver Broncos
const AWAY = nflEvent.away_team; // Seattle Seahawks
const col = (wins: number, losses: number) => ({ wins, losses, pushes: 0, winPct: (wins / (wins + losses)) * 100, count: wins + losses });

// ---- The ladders: the capture's FanDuel markets, as getAltLadders returns them ----
type FdMarket = { key: string; outcomes: { name: string; price: number; point?: number; sid?: string; link?: string }[] };
const fd = (nflEvent.bookmakers as { key: string; markets: FdMarket[] }[]).find((b) => b.key === "fanduel")!;
function ladderFor(markets: string[]): AltLadderLookup["ladders"][string] {
  const out: AltLadderLookup["ladders"][string] = {};
  for (const key of markets as ("alternate_spreads" | "alternate_totals" | "h2h")[]) {
    const m = fd.markets.find((x) => x.key === key)!;
    out[key] = { outcomes: m.outcomes, fetchedAt: NOW, marketLastUpdate: new Date("2026-10-15T13:50:00.000Z"), isStale: false };
  }
  return out;
}

const notPosted = (): AltLadder => ({ outcomes: [], fetchedAt: NOW, marketLastUpdate: null, isStale: false });

// ---- A multi-game snapshot: game i (1-based) has two cappers on Broncos +3 (or the Broncos ML) and two on Over 41.5 ----
type SideKind = "SPREAD" | "ML" | null;
type GameSpec = { side: SideKind; total: boolean; league?: string };
function snapshotOf(games: GameSpec[]): GeneratorSnapshot {
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const out: GeneratorGame[] = games.map((g, idx) => {
    const n = idx + 1;
    const league = g.league ?? "NFL";
    const picks: GeneratorPick[] = [];
    // Game 1 has the strongest cappers, game 2 the next, ...: a fixed ranking.
    const wins = 30 - n;
    const add = (capper: string, category: PickCategoryKey, detail: string, betType: string, line: number | null) => {
      const rec = col(wins, 5);
      categoryRecords[capper + "|" + category] = { key: category, label: category, ...rec };
      leagueRecords.records[capper + "|" + league + "|" + category] = { category, label: category, overall: rec, league: rec };
      picks.push({
        pickId: capper + "-" + picks.length, capperId: capper, capperName: "Capper " + capper, capperColorTag: null, capperIsFavorite: false,
        category, leagueName: league, gameId: "G" + n, gameLabel: AWAY + " @ " + HOME, betDetail: detail, odds: -110, units: 1, status: "PENDING",
        betType, period: "FULL_GAME", rawBetDetail: detail, propMarket: null, line, homeTeam: HOME, awayTeam: AWAY, gameTime: START,
        teamGroup: "HOME", teamLabel: "", teamColor: null, datePosted: "2026-10-14T00:00:00.000Z", gameNumber: null,
      } as unknown as GeneratorPick);
    };
    for (const c of ["a", "b"]) {
      if (g.side === "SPREAD") add(c + n + "s", "SPREAD_PLUS", "Broncos +3", "SPREAD", 3);
      if (g.side === "ML") add(c + n + "m", "FAV_ML", "Broncos ML", "MONEYLINE", null);
      if (g.total) add(c + n + "t", "OVER", "Over 41.5", "TOTAL", 41.5);
    }
    return { gameId: "G" + n, gameLabel: AWAY + " @ " + HOME, gameTime: START, leagueName: league, picks };
  });
  return { builtAt: NOW.toISOString(), games: out, slipPicks: [], targets: [], leagueRecords, categoryRecords };
}

const BOX: GameSpec = { side: "SPREAD", total: true };
const SETTINGS = { targetMin: -140, targetMax: -110, width: "balanced" as const, perLegRange: null, maxLegs: 4 };
const request = (over: Partial<HybridGenerateRequest> = {}): HybridGenerateRequest => ({ leagues: ["NFL"], targets: [], include: "ALL", settings: SETTINGS, ...over });

// ---- The fakes, with a call log ----
type Rig = {
  log: string[];
  scopes: unknown[];
  ladderRequests: AltLadderRequest[][];
  swingCalls: { sport: string; teams: string[] }[];
  deps: HybridDeps;
};
function rig(snapshot: GeneratorSnapshot, opts: { lookup?: (reqs: AltLadderRequest[]) => AltLadderLookup; swings?: Record<string, SwingGame[]> } = {}): Rig {
  const r: Rig = { log: [], scopes: [], ladderRequests: [], swingCalls: [], deps: null as unknown as HybridDeps };
  r.deps = {
    now: NOW,
    loadSnapshot: async (scope) => {
      r.log.push("snapshot");
      r.scopes.push(scope);
      const targets = new Set(scope.targets.map((t) => t.gameId));
      // Like the real loader: a targeted request carries only those games.
      return { snapshot: targets.size > 0 ? { ...snapshot, games: snapshot.games.filter((g) => targets.has(g.gameId)) } : snapshot, eventSportKeys: Object.fromEntries(snapshot.games.map((g) => [g.gameId, "americanfootball_nfl"])) };
    },
    getLadders: async (reqs) => {
      r.log.push("ladders");
      r.ladderRequests.push(reqs);
      return opts.lookup ? opts.lookup(reqs) : { ladders: Object.fromEntries(reqs.map((q) => [q.eventId, ladderFor(q.markets)])), pricingInProgress: [] };
    },
    getSwings: async (args) => {
      r.log.push("swings:" + args.sport);
      r.swingCalls.push({ sport: args.sport, teams: [...args.teams].sort() });
      return Object.fromEntries(args.teams.map((t) => [t, opts.swings?.[t] ?? []]));
    },
    leagueKey: (label) => ({ NFL: "americanfootball_nfl", NBA: "basketball_nba" })[label],
  };
  return r;
}
const run = async (r: Rig, req: HybridGenerateRequest) => {
  const res = await runHybridGenerate(req, r.deps);
  if ("error" in res) throw new Error(res.error);
  return res as HybridGenerateResponse;
};
const asked = (r: Rig) => r.ladderRequests.flat().map((q) => q.eventId).sort();

async function main() {
  const eight = snapshotOf(Array.from({ length: 8 }, () => BOX));

  // ---- 1. The flow: snapshot -> ladders (candidate events only) -> swings -> optimizer ----
  {
    const r = rig(eight);
    const res = await run(r, request());
    check("order: snapshot, then ladders once, then swings once", r.log, ["snapshot", "ladders", "swings:americanfootball_nfl"]);
    check("the slip is ignored: the loader is asked for an empty slip", (r.scopes[0] as { slipPickIds: string[] }).slipPickIds, []);
    check("league scope passes through", (r.scopes[0] as { leagues: string[] }).leagues, ["NFL"]);
    check("a primary came back", res.result.primary !== null && res.result.primary.structure === "same-game-box", true);

    // The same positions straight into the optimizer give the same answer.
    const positions = buildConsensusPositions(eight, { now: NOW });
    const candidate = new Set(res.candidateEvents);
    const direct = optimizeHybrid({
      positions: positions.filter((p) => candidate.has(p.eventId)),
      ladders: Object.fromEntries(r.ladderRequests.flat().map((q) => [q.eventId, ladderFor(q.markets)])),
      swings: Object.fromEntries([HOME, AWAY].map((t) => [t, []])),
      settings: { targetMin: -140, targetMax: -110, width: "balanced", legRange: null, maxLegs: 4 },
    });
    check("the result is the optimizer's, untouched", res.result, direct);
    check("sport keys for the link are returned for the asked events", Object.keys(res.eventSportKeys).sort(), asked(r));
  }

  // ---- 2. Ladders only for the candidate events ----
  {
    const r = rig(eight);
    await run(r, request());
    // 8 box games: the top 6, then the next positions' events for the extra legs (maxLegs 4 -> 2 more).
    check("maxLegs 4: the top 6 box games + 2 more events", asked(r), ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"]);
    const r2 = rig(eight);
    await run(r2, request({ settings: { ...SETTINGS, maxLegs: 2 } }));
    check(`maxLegs 2: exactly the top ${HYBRID_CANDIDATE_GAMES} box games`, asked(r2), ["G1", "G2", "G3", "G4", "G5", "G6"]);
    const r3 = rig(eight);
    await run(r3, request({ settings: { ...SETTINGS, maxLegs: 3 } }));
    check("maxLegs 3: the top 6 + 1 more", asked(r3), ["G1", "G2", "G3", "G4", "G5", "G6", "G7"]);
    check("the events above never include a game with no position", chooseCandidateEvents(buildConsensusPositions(snapshotOf([BOX, { side: null, total: false }]), { now: NOW }), 4), ["G1"]);
  }

  // ---- 3. Markets per event: spreads for a side, totals for a total, h2h ONLY with ML supporters ----
  {
    const mixed = snapshotOf([BOX, { side: "ML", total: true }, { side: "SPREAD", total: false }, { side: null, total: true }]);
    const r = rig(mixed);
    await run(r, request());
    const marketsOf = (id: string) => r.ladderRequests.flat().find((q) => q.eventId === id)?.markets;
    check("spread + total supporters: alternate_spreads + alternate_totals, NO h2h", marketsOf("G1"), ["alternate_spreads", "alternate_totals"]);
    check("moneyline supporters: h2h is added", marketsOf("G2"), ["alternate_spreads", "alternate_totals", "h2h"]);
    check("a side with no total asks for no totals", marketsOf("G3"), ["alternate_spreads"]);
    check("a total with no side asks for no spreads", marketsOf("G4"), ["alternate_totals"]);
    check("h2h is requested for one event only", r.ladderRequests.flat().filter((q) => q.markets.includes("h2h")).map((q) => q.eventId), ["G2"]);
    check("every request carries the event's own sport key and start", r.ladderRequests.flat().every((q) => q.sport === "americanfootball_nfl" && q.commenceTime === START), true);
  }

  // ---- 4. Targeted games restrict the events fetched (even if the loader hands back more) ----
  {
    const r = rig(eight);
    r.deps.loadSnapshot = async (scope) => {
      r.log.push("snapshot");
      r.scopes.push(scope);
      return { snapshot: eight, eventSportKeys: {} }; // a loader that ignores the targets
    };
    await run(r, request({ targets: [{ gameId: "G3", leagueName: "NFL" }, { gameId: "G5", leagueName: "NFL" }] }));
    check("targets G3 + G5: ladders asked for those two only", asked(r), ["G3", "G5"]);
    check("the targets reach the loader", (r.scopes[0] as { targets: unknown[] }).targets.length, 2);
    check("swings: only the targeted games' teams", r.swingCalls[0].teams, [AWAY, HOME].sort());
    check("a targeted request fell back to the sport key from the league", r.ladderRequests[0].every((q) => q.sport === "americanfootball_nfl"), true);
  }

  // ---- 5. Include Picks: only the selected markets feed the positions ----
  {
    const r = rig(eight);
    await run(r, request({ include: ["SPREAD"] }));
    check("Spread only: no totals asked for, nothing box-eligible -> fallback events", r.ladderRequests.flat().every((q) => !q.markets.includes("alternate_totals")), true);
    const t = rig(eight);
    const res = await run(t, request({ include: ["TOTALS"] }));
    check("Totals only: no spread or h2h asked for", t.ladderRequests.flat().every((q) => q.markets.join() === "alternate_totals"), true);
    check("Totals only: no team side, so no box -> the cross-game fallback of two totals", [res.result.primary?.structure, res.result.primary?.legs.map((l) => l.family)], ["cross-game", ["TOTAL", "TOTAL"]]);
    const m = rig(snapshotOf([{ side: "ML", total: true }]));
    await run(m, request({ include: ["SPREAD", "TOTALS"] }));
    check("Spread + Totals (no Moneyline): the ML picks are dropped, so no h2h", m.ladderRequests.flat().every((q) => !q.markets.includes("h2h")), true);
  }

  // ---- 6. Cross-game fallback events when nothing is box-eligible ----
  {
    const sides = snapshotOf(Array.from({ length: 8 }, () => ({ side: "SPREAD" as SideKind, total: false })));
    const r = rig(sides);
    await run(r, request());
    check("no box game: maxLegs + 1 events (5)", asked(r), ["G1", "G2", "G3", "G4", "G5"]);
    const r2 = rig(sides);
    await run(r2, request({ settings: { ...SETTINGS, maxLegs: 2 } }));
    check("no box game, 2 legs: 3 events (two plus a spare)", asked(r2), ["G1", "G2", "G3"]);
  }

  // ---- 7. Swings: one call per sport involved, only the candidate events' teams ----
  {
    const two = snapshotOf([BOX, { ...BOX, league: "NBA" }]);
    const r = rig(two);
    await run(r, request({ leagues: ["NFL", "NBA"] }));
    check("two sports -> two swing calls", r.log.filter((l) => l.startsWith("swings:")).sort(), ["swings:americanfootball_nfl", "swings:basketball_nba"]);
    const empty = rig(snapshotOf([{ side: null, total: false }]));
    const res = await run(empty, request());
    check("no position at all: no ladder or swing read, the optimizer's own note", [empty.log, res.result.primary, typeof res.result.note], [["snapshot"], null, "string"]);
  }

  // ---- 8. Availability notes ----
  {
    // G1: FanDuel has not posted alternate lines (a stored, empty ladder). G2: another request is pricing it.
    const lookup = (reqs: AltLadderRequest[]): AltLadderLookup => {
      const ladders: AltLadderLookup["ladders"] = {};
      for (const q of reqs) {
        if (q.eventId === "G1") ladders[q.eventId] = { alternate_spreads: notPosted(), alternate_totals: notPosted() };
        else if (q.eventId !== "G2") ladders[q.eventId] = ladderFor(q.markets);
      }
      return { ladders, pricingInProgress: [{ eventId: "G2", market: "alternate_spreads" }, { eventId: "G2", market: "alternate_totals" }] };
    };
    const r = rig(eight, { lookup });
    const res = await run(r, request());
    check("notes: not-posted on G1, pricing-in-progress once on G2", res.notes.map((n) => [n.eventId, n.kind]), [["G1", "alt-lines-not-posted"], ["G2", "pricing-in-progress"]]);
    check("the not-posted note says exactly what was asked for", res.notes[0].message, "Alternate lines post on game day (FanDuel).");
    check("...and the constants agree", [res.notes[0].message, res.notes[1].message], [ALT_LINES_NOT_POSTED_NOTE, PRICING_IN_PROGRESS_NOTE]);
    check("the notes name the game", res.notes[0].gameLabel, AWAY + " @ " + HOME);
    check("the optimizer skips both events and still builds from the rest", res.result.primary !== null && res.result.primary.legs.every((l) => l.eventId !== "G1" && l.eventId !== "G2"), true);

    // Everything not posted: no hybrid, but the notes explain it.
    const none = rig(snapshotOf([BOX, BOX]), {
      lookup: (reqs) => ({ ladders: Object.fromEntries(reqs.map((q) => [q.eventId, { alternate_spreads: notPosted(), alternate_totals: notPosted() }])), pricingInProgress: [] }),
    });
    const r2 = await run(none, request());
    check("all events not posted: no primary, one note each", [r2.result.primary, r2.notes.map((n) => n.eventId)], [null, ["G1", "G2"]]);

    // In progress with nothing else: a note, not a no-fit.
    const wait = rig(snapshotOf([BOX]), { lookup: () => ({ ladders: {}, pricingInProgress: [{ eventId: "G1", market: "alternate_spreads" }] }) });
    const r3 = await run(wait, request());
    check("pricing in progress is reported as a note on the event", [r3.result.primary, r3.notes.map((n) => n.kind)], [null, ["pricing-in-progress"]]);
  }

  // ---- 9. A rejection from the loader passes straight through ----
  {
    const r = rig(eight);
    r.deps.loadSnapshot = async () => ({ error: "Your slip has changed" });
    const res = await runHybridGenerate(request(), r.deps);
    check("loader rejection returned as-is", res, { error: "Your slip has changed" });
    check("...and nothing else was read", r.log, []);
  }

  // ---- 10. The handoff's server half: cache-first reads for exactly the legs' markets ----
  {
    const NBA_START = new Date("2026-10-15T23:00:00.000Z");
    const legs = [
      { eventId: "E1", sportKey: "americanfootball_nfl", marketKey: "alternate_spreads" as const, outcomeName: HOME, point: 3.5 },
      { eventId: "E1", sportKey: "americanfootball_nfl", marketKey: "alternate_totals" as const, outcomeName: "Over", point: 38.5 },
    ];
    const seen: AltLadderRequest[][] = [];
    const deps = (over: Partial<Parameters<typeof buildHybridFanDuelLink>[1]> = {}) => ({
      now: NOW,
      getCommenceTimes: async () => new Map([["E1", NBA_START]]),
      getLadders: async (reqs: AltLadderRequest[]): Promise<AltLadderLookup> => {
        seen.push(reqs);
        return { ladders: Object.fromEntries(reqs.map((q) => [q.eventId, ladderFor(q.markets)])), pricingInProgress: [] };
      },
      ...over,
    });
    const ok = await buildHybridFanDuelLink(legs, deps());
    check("one request for the event, the union of its legs' markets, the event's own sport key and start", seen[0], [{ eventId: "E1", sport: "americanfootball_nfl", commenceTime: NBA_START, markets: ["alternate_spreads", "alternate_totals"] }]);
    check("both legs matched -> a two-selection link for ONE event", [ok.legs.map((l) => l.status), ok.url !== null && decodeURIComponent(ok.url).includes("marketId[1]")], [["matched", "matched"], true]);

    const started = await buildHybridFanDuelLink(legs, deps({ now: new Date("2026-10-16T01:00:00.000Z"), getCommenceTimes: async () => new Map([["E1", new Date("2026-10-16T00:15:00.000Z")]]) }));
    check("a game that has started: no read, no link", [started.url, started.legs.map((l) => l.status), seen.length], [null, ["gone", "gone"], 1]);
    const unknown = await buildHybridFanDuelLink(legs, deps({ getCommenceTimes: async () => new Map() }));
    check("an event with no cached row: no link, asks to generate again", [unknown.url, unknown.legs[0].status === "gone" && unknown.legs[0].reason.includes("generate again")], [null, true]);
    const waiting = await buildHybridFanDuelLink(legs, deps({ getLadders: async () => ({ ladders: {}, pricingInProgress: [{ eventId: "E1", market: "alternate_totals" }] }) }));
    check("pricing in progress on one market: no partial slip", [waiting.url, waiting.legs.map((l) => l.status)], [null, ["gone", "gone"]]);
  }

  console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
