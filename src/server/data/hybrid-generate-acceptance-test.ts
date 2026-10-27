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
const TEAMS: Record<string, [string, string, string]> = {
  NFL: [HOME, AWAY, "Broncos"],
  NHL: ["Detroit Red Wings", "New Jersey Devils", "Red Wings"],
  MLB: ["Chicago Cubs", "Boston Red Sox", "Cubs"],
};
type SideKind = "SPREAD" | "ML" | null;
type GameSpec = { side: SideKind; total: boolean; league?: string };
function snapshotOf(games: GameSpec[], record?: (n: number) => [number, number]): GeneratorSnapshot {
  const categoryRecords: Record<string, CategoryBreakdownItem | null> = {};
  const leagueRecords: CapperLeagueRecords = { records: {}, streaks: {}, last20: {} };
  const out: GeneratorGame[] = games.map((g, idx) => {
    const n = idx + 1;
    const league = g.league ?? "NFL";
    const [home, away, nick] = TEAMS[league] ?? TEAMS.NFL;
    const picks: GeneratorPick[] = [];
    // Game 1 has the strongest cappers, game 2 the next, ...: a fixed ranking.
    const [wins, losses] = record ? record(n) : [30 - n, 5];
    const add = (capper: string, category: PickCategoryKey, detail: string, betType: string, line: number | null) => {
      const rec = col(wins, losses);
      categoryRecords[capper + "|" + category] = { key: category, label: category, ...rec };
      leagueRecords.records[capper + "|" + league + "|" + category] = { category, label: category, overall: rec, league: rec };
      picks.push({
        pickId: capper + "-" + picks.length, capperId: capper, capperName: "Capper " + capper, capperColorTag: null, capperIsFavorite: false,
        category, leagueName: league, gameId: "G" + n, gameLabel: away + " @ " + home, betDetail: detail, odds: -110, units: 1, status: "PENDING",
        betType, period: "FULL_GAME", rawBetDetail: detail, propMarket: null, line, homeTeam: home, awayTeam: away, gameTime: START,
        teamGroup: "HOME", teamLabel: "", teamColor: null, datePosted: "2026-10-14T00:00:00.000Z", gameNumber: null,
      } as unknown as GeneratorPick);
    };
    for (const c of ["a", "b"]) {
      if (g.side === "SPREAD") add(c + n + "s", "SPREAD_PLUS", nick + (league === "NFL" ? " +3" : " +1.5"), "SPREAD", league === "NFL" ? 3 : 1.5);
      if (g.side === "ML") add(c + n + "m", "FAV_ML", nick + " ML", "MONEYLINE", null);
      if (g.total) add(c + n + "t", "OVER", "Over 41.5", "TOTAL", 41.5);
    }
    return { gameId: "G" + n, gameLabel: away + " @ " + home, gameTime: START, leagueName: league, picks };
  });
  return { builtAt: NOW.toISOString(), games: out, slipPicks: [], targets: [], leagueRecords, categoryRecords };
}

const BOX: GameSpec = { side: "SPREAD", total: true };
const SETTINGS = { targetMin: -140, targetMax: -110, width: "balanced" as const, perLegRange: null, maxLegs: 4, minWinPct: 55 };
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

  // ---- 11. Backfill: unposted top-6 box games are replaced by the next box-eligible games, once ----
  {
    const unpostedSet = new Set(["G1", "G2", "G3"]);
    const lookupWith = (unposted: Set<string>) => (reqs: AltLadderRequest[]): AltLadderLookup => ({
      ladders: Object.fromEntries(reqs.map((q) => [q.eventId, unposted.has(q.eventId) ? { alternate_spreads: notPosted(), alternate_totals: notPosted() } : ladderFor(q.markets)])),
      pricingInProgress: [],
    });
    const two = { ...SETTINGS, maxLegs: 2 };

    // NBA day-before: 3 of the top 6 unposted, 10 eligible games.
    const ten = snapshotOf(Array.from({ length: 10 }, () => BOX));
    const r = rig(ten, { lookup: lookupWith(unpostedSet) });
    const res = await run(r, request({ settings: two }));
    check("two passes: the top 6, then ONLY the 3 replacements", r.ladderRequests.map((q) => q.map((x) => x.eventId).sort()), [["G1", "G2", "G3", "G4", "G5", "G6"], ["G7", "G8", "G9"]]);
    const askedIds = r.ladderRequests.flat().map((q) => q.eventId);
    check("the candidates reach 6 posted box games", askedIds.filter((id) => !unpostedSet.has(id)).length, 6);
    check("no unposted game is asked for twice", new Set(askedIds).size, askedIds.length);
    check("the result is built from posted games only", res.result.primary !== null && [res.result.primary, ...res.result.alternates].every((h) => h.legs.every((l) => !unpostedSet.has(l.eventId))), true);
    check("the three unposted games each carry the note", res.notes.map((n) => [n.eventId, n.kind]), [["G1", "alt-lines-not-posted"], ["G2", "alt-lines-not-posted"], ["G3", "alt-lines-not-posted"]]);
    check("candidateEvents lists all nine asked", res.candidateEvents.length, 9);

    // Fewer eligible games than needed: it runs out, with no error.
    const eight = snapshotOf(Array.from({ length: 8 }, () => BOX));
    const r2 = rig(eight, { lookup: lookupWith(unpostedSet) });
    const res2 = await run(r2, request({ settings: two }));
    check("8 eligible: the second pass takes the 2 that exist", r2.ladderRequests.map((q) => q.map((x) => x.eventId).sort()), [["G1", "G2", "G3", "G4", "G5", "G6"], ["G7", "G8"]]);
    check("...and a hybrid still comes back", res2.result.primary !== null, true);
    const r2b = rig(snapshotOf(Array.from({ length: 6 }, () => BOX)), { lookup: lookupWith(unpostedSet) });
    await run(r2b, request({ settings: two }));
    check("6 eligible, 3 unposted: nothing to backfill with, no second pass", r2b.ladderRequests.length, 1);

    // The replacements are unposted too: still just two passes (the spend is bounded).
    const r3 = rig(ten, { lookup: lookupWith(new Set(["G1", "G2", "G3", "G7", "G8", "G9"])) });
    const res3 = await run(r3, request({ settings: two }));
    check("replacements unposted as well: exactly two passes, no third", r3.ladderRequests.length, 2);
    check("...and the rest still build a hybrid from the 3 posted", res3.result.primary !== null, true);

    // All posted: one pass.
    const r4 = rig(ten);
    await run(r4, request({ settings: two }));
    check("nothing unposted: one pass", r4.ladderRequests.length, 1);

    // maxLegs 4: the two extra events are fetched in pass one; the replacements come after them.
    const r5 = rig(ten, { lookup: lookupWith(unpostedSet) });
    await run(r5, request());
    check("maxLegs 4: pass one is 6 box + 2 extra; pass two the 2 box games left", r5.ladderRequests.map((q) => q.length), [8, 2]);
  }

  // ---- 12. h2h for hockey and baseball (the moneyline is their main line) ----
  {
    for (const league of ["NHL", "MLB", "NFL"]) {
      const r = rig(snapshotOf([{ side: "SPREAD", total: true, league }]));
      r.deps.leagueKey = (label) => ({ NHL: "icehockey_nhl", MLB: "baseball_mlb", NFL: "americanfootball_nfl" })[label];
      await run(r, request({ leagues: [league] }));
      const m = r.ladderRequests.flat()[0].markets;
      check(league + ": spread/total supporters only -> h2h " + (league === "NFL" ? "NOT " : "") + "requested", m.includes("h2h"), league !== "NFL");
    }
    const tot = rig(snapshotOf([{ side: null, total: true, league: "NHL" }]));
    await run(tot, request({ leagues: ["NHL"] }));
    check("NHL total with no team side: no h2h (nothing needs it)", tot.ladderRequests.flat()[0].markets, ["alternate_totals"]);
  }

  // ---- 13. minWinPct reaches the qualification ----
  {
    const weak = snapshotOf([BOX], () => [7, 3]); // 70%
    const at55 = rig(weak);
    await run(at55, request({ settings: { ...SETTINGS, minWinPct: 55 } }));
    check("70% cappers qualify at a 55 gate", at55.ladderRequests.length, 1);
    const at75 = rig(weak);
    const res = await run(at75, request({ settings: { ...SETTINGS, minWinPct: 75 } }));
    check("...and do not at 75: no positions, no ladder read", [at75.ladderRequests.length, res.result.primary], [0, null]);
  }

  // ---- 14. the link: a stale ladder is re-priced ONCE; still stale -> no link ----
  {
    const start = new Date("2026-10-15T23:00:00.000Z");
    const legs = [
      { eventId: "E1", sportKey: "americanfootball_nfl", marketKey: "alternate_spreads" as const, outcomeName: HOME, point: 3.5 },
      { eventId: "E1", sportKey: "americanfootball_nfl", marketKey: "alternate_totals" as const, outcomeName: "Over", point: 38.5 },
    ];
    const ladders = (stale: string[]) => (reqs: AltLadderRequest[]): AltLadderLookup => ({
      ladders: Object.fromEntries(reqs.map((q) => [q.eventId, Object.fromEntries(q.markets.map((m) => [m, { ...(ladderFor([m]) as Record<string, AltLadder>)[m], isStale: stale.includes(m) }]))])),
      pricingInProgress: [],
    });
    const calls: AltLadderRequest[][] = [];
    const mk = (answers: ((r: AltLadderRequest[]) => AltLadderLookup)[]) => {
      calls.length = 0;
      return { now: NOW, getCommenceTimes: async () => new Map([["E1", start]]), getLadders: async (r: AltLadderRequest[]) => (calls.push(r), answers[Math.min(calls.length - 1, answers.length - 1)](r)) };
    };

    const fixed = await buildHybridFanDuelLink(legs, mk([ladders(["alternate_totals"]), ladders([])]));
    check("stale -> re-priced -> link built", [fixed.url !== null, fixed.legs.map((l) => l.status), fixed.anyStale], [true, ["matched", "matched"], false]);
    check("...the re-price asked for ONLY the stale market, once", [calls.length, calls[1].map((q) => [q.eventId, q.markets])], [2, [["E1", ["alternate_totals"]]]]);

    const still = await buildHybridFanDuelLink(legs, mk([ladders(["alternate_totals"])]));
    check("stale -> still stale -> NO link, the stale leg named", [still.url, still.legs.map((l) => l.status), still.anyStale], [null, ["matched", "gone"], true]);
    check("...exactly one re-price (two reads in all)", calls.length, 2);
    check("...with the reason", still.legs[1].status === "gone" && still.legs[1].reason.startsWith("FanDuel's odds couldn't be refreshed"), true);

    const fresh = await buildHybridFanDuelLink(legs, mk([ladders([])]));
    check("nothing stale: one read, no re-price", [fresh.url !== null, calls.length], [true, 1]);
  }

  console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
