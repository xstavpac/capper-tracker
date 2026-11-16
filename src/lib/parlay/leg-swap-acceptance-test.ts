// Proof for swapping one leg by hand (legAlternatives / legSwapOptions / applyLegSwap in
// generator.ts, and the session's swapOptions / swapLeg). The modal's tabs have their own
// proof (swap-modal-acceptance-test.ts). Pinned:
//   - This game: only picks on the swapped leg's game; Other games: never a game already in the parlay;
//   - no alternative is in the parlay or the slip, opposes a same-game leg, or breaks max legs per game;
//   - every alternative clears the win-rate gate and the star; ordered by the build's ranking;
//   - repeated swaps (the same leg, other legs) stay valid against the current legs;
//   - SGP / no-odds states follow the legs (an Other-games swap that breaks a pair), priced by combineOdds;
//   - Other games lists every eligible pick (several per game), in ranking order;
//   - Hedge / Contrarian (the run log's) stay the build's after a swap;
//   - Your picks only: unused slip picks only, ungated;
//   - a game that started since the snapshot: only as a target or a slip pick's game;
//   - the session: no request for a swap (even when stale), Regenerate clears handSwapped.
// Pure - no DB. Run with:
//   node --require ./scripts/server-only-stub.cjs --import tsx src/lib/parlay/leg-swap-acceptance-test.ts
import {
  applyLegSwap,
  buildGeneratedParlay,
  legAlternatives,
  legSwapOptions,
  SWAP_TAB_KEYS,
  type LegSwapOptions,
  type EngineLeg,
  type GeneratedParlay,
  type GeneratorSettings,
  type GeneratorSnapshot,
} from "@/lib/parlay/generator";
import { createGeneratorSession } from "@/lib/parlay/generator-session";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import { sameGameConflict } from "@/lib/parlay/same-game-rules";
import { toParlayCandidate, toParlayLeg } from "@/lib/parlay/qualification-core";
import { combineOdds } from "@/lib/parlay/combine-odds";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const NOW = new Date("2099-06-01T12:00:00.000Z");
const LATER = "2099-06-01T23:00:00.000Z";
const TEAMS: [string, string][] = [
  ["New York Yankees", "Boston Red Sox"],
  ["Toronto Blue Jays", "Tampa Bay Rays"],
  ["Houston Astros", "Baltimore Orioles"],
  ["Cleveland Guardians", "Detroit Tigers"],
  ["Seattle Mariners", "Texas Rangers"],
  ["Chicago Cubs", "St. Louis Cardinals"],
];
type Kind = "HOME_ML" | "AWAY_ML" | "OVER" | "UNDER";
const categoryRecords: GeneratorSnapshot["categoryRecords"] = {};
function mk(id: string, g: number, kind: Kind, wins: number, opts: { favorite?: boolean; odds?: number; gameTime?: string } = {}): GeneratorPick {
  const [home, away] = TEAMS[g];
  const category = kind === "HOME_ML" ? "FAV_ML" : kind === "AWAY_ML" ? "DOG_ML" : kind;
  categoryRecords["cap-" + id + "|" + category] = { key: category, label: category, wins, losses: 40 - wins, pushes: 0, winPct: (wins / 40) * 100, count: 40 };
  const detail = kind === "HOME_ML" ? home + " ML" : kind === "AWAY_ML" ? away + " ML" : kind === "OVER" ? "Over 8.5" : "Under 8.5";
  return {
    pickId: id, capperId: "cap-" + id, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: opts.favorite === true, category, leagueName: "MLB",
    gameId: "G" + g, gameLabel: away + " @ " + home, betDetail: detail, odds: opts.odds ?? (kind === "AWAY_ML" ? 120 : -110), units: 1, status: "PENDING",
    betType: kind === "OVER" || kind === "UNDER" ? "TOTAL" : "MONEYLINE", period: "FULL_GAME", rawBetDetail: detail, line: kind === "OVER" || kind === "UNDER" ? 8.5 : null,
    homeTeam: home, awayTeam: away, gameTime: opts.gameTime ?? LATER, teamGroup: kind === "AWAY_ML" ? "AWAY" : "HOME", teamLabel: "", teamColor: null, datePosted: "2099-05-31T00:00:00.000Z",
  } as GeneratorPick;
}
// Every game: home ML, away ML (opposes it), Over, Under (opposes it). Wins fall by game, so G0 is strongest.
// g?low: a pick under any gate. Favorites: the away MLs of G1, G3 and G5, and the Overs of G0-G3.
const PICKS: GeneratorPick[] = TEAMS.flatMap((_, g) => [
  mk(`g${g}h`, g, "HOME_ML", 32 - g),
  mk(`g${g}a`, g, "AWAY_ML", 27 - g, { favorite: g % 2 === 1 }),
  mk(`g${g}o`, g, "OVER", 30 - g, { favorite: g < 4 }),
  mk(`g${g}u`, g, "UNDER", 25 - g),
  mk(`g${g}low`, g, "OVER", 8),
]);
const byId = new Map(PICKS.map((p) => [p.pickId, p]));
const gamesOf = (picks: GeneratorPick[]): GeneratorGame[] =>
  TEAMS.map((_, g) => ({ gameId: "G" + g, gameLabel: picks.find((p) => p.gameId === "G" + g)?.gameLabel ?? "G" + g, gameTime: picks.find((p) => p.gameId === "G" + g)?.gameTime ?? LATER, leagueName: "MLB", picks: picks.filter((p) => p.gameId === "G" + g) }));
function snapshotOf(slipIds: string[] = [], targets: string[] = [], picks = PICKS): GeneratorSnapshot {
  return { builtAt: NOW.toISOString(), games: gamesOf(picks), slipPicks: slipIds.map((id) => byId.get(id)!), targets, leagueRecords: { records: {}, streaks: {}, last20: {} }, categoryRecords };
}
const base: GeneratorSettings = { legCount: 3, maxLegsPerGame: 1, include: ["ALL"] as never, mix: null, fillFrom: "BEST_AVAILABLE", minWinPct: 55 };
const ids = (ls: EngineLeg[]) => ls.map((l) => l.pick.pickId);
const asC = (p: GeneratorPick) => toParlayCandidate(toParlayLeg(p));
const all = (a: { thisGame: EngineLeg[]; otherGames: EngineLeg[] }) => [...a.thisGame, ...a.otherGames];
const optionIds = (o: LegSwapOptions) => SWAP_TAB_KEYS.flatMap((t) => o[t]).filter((x) => !x.current).map((x) => x.pick.pickId);
const scoreOrdered = (ls: EngineLeg[]) => ls.every((l, i) => i === 0 || (ls[i - 1].score ?? 0) >= (l.score ?? 0));

// Every rule, against the legs the alternatives were asked for.
function validAgainst(snapshot: GeneratorSnapshot, settings: GeneratorSettings, legs: EngineLeg[], index: number, alts: { thisGame: EngineLeg[]; otherGames: EngineLeg[] }): string[] {
  const bad: string[] = [];
  const inParlay = new Set(ids(legs));
  const slip = new Set(snapshot.slipPicks.map((p) => p.pickId));
  const parlayGames = new Set(legs.map((l) => l.gameId));
  const others = legs.filter((_, i) => i !== index);
  for (const a of alts.thisGame) if (a.gameId !== legs[index].gameId) bad.push(a.pick.pickId + " this-game on another game");
  for (const a of alts.otherGames) if (parlayGames.has(a.gameId)) bad.push(a.pick.pickId + " other-games on a parlay game");
  for (const a of all(alts)) {
    if (inParlay.has(a.pick.pickId)) bad.push(a.pick.pickId + " already in the parlay");
    if (settings.fillFrom === "BEST_AVAILABLE" && slip.has(a.pick.pickId)) bad.push(a.pick.pickId + " is a slip pick");
    const siblings = others.filter((l) => l.gameId === a.gameId);
    if (siblings.length >= settings.maxLegsPerGame) bad.push(a.pick.pickId + " breaks max legs per game");
    for (const s of siblings) if (sameGameConflict(asC(a.pick), asC(s.pick)) !== null) bad.push(a.pick.pickId + " conflicts with " + s.pick.pickId);
    if (settings.fillFrom === "BEST_AVAILABLE" && settings.favoritesOnly && !a.pick.capperIsFavorite) bad.push(a.pick.pickId + " not a favorite");
    if (settings.fillFrom === "BEST_AVAILABLE" && (a.record?.winPct ?? 0) < (settings.minWinPct ?? 55) - 1e-9 && a.pick.pickId.endsWith("low")) bad.push(a.pick.pickId + " below the gate");
  }
  return bad;
}

async function main() {
  // ---- Best available, one leg per game ----
  const snap = snapshotOf();
  const p0 = buildGeneratedParlay(snap, base, null, NOW);
  check("fixture: a 3-leg parlay on 3 games", p0.legs.length === 3 && new Set(p0.legs.map((l) => l.gameId)).size === 3, ids(p0.legs).join(","));
  const a0 = legAlternatives(snap, base, p0.legs, 0, NOW);
  check("This game: only picks on the swapped leg's game", a0.thisGame.length > 0 && a0.thisGame.every((l) => l.gameId === p0.legs[0].gameId), ids(a0.thisGame).join(","));
  check("Other games: never a game already in the parlay", a0.otherGames.length > 0 && a0.otherGames.every((l) => !p0.legs.some((x) => x.gameId === l.gameId)), ids(a0.otherGames).join(","));
  const otherGameIds = a0.otherGames.map((l) => l.gameId);
  check("Other games: every eligible pick, several per game (no one-row-per-game cut)", new Set(otherGameIds).size < otherGameIds.length, otherGameIds.join(","));
  check("Other games: each game's best pick (the home ML) is among them", Array.from(new Set(otherGameIds)).every((gid) => a0.otherGames.some((row) => row.pick.pickId === "g" + gid.slice(1) + "h")), ids(a0.otherGames).join(","));
  check("every rule holds (in parlay, slip, conflicts, max per game, gate)", validAgainst(snap, base, p0.legs, 0, a0).length === 0, validAgainst(snap, base, p0.legs, 0, a0).join("; "));
  check("the win-rate gate: no below-gate pick is offered", !all(a0).some((l) => l.pick.pickId.endsWith("low")));
  check("each tab is in the engine's ranking order (score, best first)", scoreOrdered(a0.thisGame) && scoreOrdered(a0.otherGames));
  check("every alternative is a generated leg with its gated record", all(a0).every((l) => l.source === "GENERATED" && l.record !== null && l.basis !== null));
  const strict = legAlternatives(snap, { ...base, minWinPct: 70 }, p0.legs, 0, NOW);
  check("a higher gate offers fewer, each clearing it", all(strict).length < all(a0).length && all(strict).every((l) => (l.record?.winPct ?? 0) >= 70), ids(all(strict)).join(","));

  // ---- The modal's tabs are these alternatives, sorted ----
  const o0 = legSwapOptions(snap, base, p0.legs, 0, NOW);
  check("swap options: Other games is exactly the alternatives' Other games", ids(o0.OTHER_GAMES).join() === ids(a0.otherGames).join());
  check("swap options: every same-game tab row is a This-game alternative", ["PRIMARY", "HEDGE", "CONTRARIAN"].every((t) => o0[t as "PRIMARY"].filter((x) => !x.current).every((x) => a0.thisGame.some((l) => l.pick.pickId === x.pick.pickId))));
  check("swap options: the opposing ML is Contrarian, the totals Hedge (an ML leg)", ids(o0.CONTRARIAN).join() === "g" + p0.legs[0].gameId.slice(1) + "a" && o0.HEDGE.length === 2, JSON.stringify(Object.fromEntries(SWAP_TAB_KEYS.map((t) => [t, ids(o0[t])]))));

  // ---- The star ----
  const fav: GeneratorSettings = { ...base, favoritesOnly: true };
  const pf = buildGeneratedParlay(snap, fav, null, NOW);
  const af = legAlternatives(snap, fav, pf.legs, 0, NOW);
  check("star: every alternative is a favorite capper's", all(af).length > 0 && all(af).every((l) => l.pick.capperIsFavorite === true), ids(all(af)).join(","));

  // ---- Same-game: opposing sides and max legs per game ----
  const sgp: GeneratorSettings = { ...base, legCount: 8, maxLegsPerGame: 2 };
  const ps = buildGeneratedParlay(snap, sgp, null, NOW);
  const pairIndex = ps.legs.findIndex((l) => ps.legs.filter((x) => x.gameId === l.gameId).length === 2);
  check("fixture: an 8-leg parlay with same-game pairs", ps.legs.length === 8 && pairIndex >= 0 && ps.sameGameGames > 0, ids(ps.legs).join(","));
  const as = legAlternatives(snap, sgp, ps.legs, pairIndex, NOW);
  check("same game: every rule holds against the pair's other leg", validAgainst(snap, sgp, ps.legs, pairIndex, as).length === 0, validAgainst(snap, sgp, ps.legs, pairIndex, as).join("; "));
  const sibling = ps.legs.find((l, i) => i !== pairIndex && l.gameId === ps.legs[pairIndex].gameId)!;
  const opposite = ps.legs[pairIndex].gameId === sibling.gameId ? PICKS.filter((p) => p.gameId === sibling.gameId && sameGameConflict(asC(p), asC(sibling.pick)) !== null) : [];
  check("same game: no pick opposing the other leg on the game is offered", opposite.length > 0 && !as.thisGame.some((l) => opposite.some((o) => o.pickId === l.pick.pickId)), ids(as.thisGame).join(","));
  // Three legs on one game with max 2: the swapped leg's game has no room for anything but a like-for-like.
  const crowded: EngineLeg[] = [ps.legs[pairIndex], sibling, { ...sibling, pick: byId.get("g5h")!, gameId: sibling.gameId }];
  const ac = legAlternatives(snap, sgp, crowded, 0, NOW);
  check("max legs per game: none when the game's other legs already fill it", ac.thisGame.length === 0, ids(ac.thisGame).join(","));

  // ---- Repeated swaps ----
  let cur: GeneratedParlay = p0;
  const firstLeg = cur.legs[0].pick.pickId;
  const s1 = applyLegSwap(snap, base, cur, 0, a0.thisGame[0].pick.pickId, NOW)!;
  check("swap: the leg is replaced in place, others unchanged", s1.legs[0].pick.pickId === a0.thisGame[0].pick.pickId && ids(s1.legs).slice(1).join() === ids(cur.legs).slice(1).join());
  check("swap: the new leg is handSwapped, the others aren't", s1.legs[0].handSwapped === true && s1.legs.slice(1).every((l) => !l.handSwapped));
  const r1 = legAlternatives(snap, base, s1.legs, 0, NOW);
  check("swap again (same leg): the current pick isn't in its own tray, the replaced one is back", !all(r1).some((l) => l.pick.pickId === s1.legs[0].pick.pickId) && r1.thisGame.some((l) => l.pick.pickId === firstLeg));
  check("swap again (same leg): every rule holds against the current legs", validAgainst(snap, base, s1.legs, 0, r1).length === 0, validAgainst(snap, base, s1.legs, 0, r1).join("; "));
  const a1 = legAlternatives(snap, base, s1.legs, 1, NOW);
  check("another leg: alternatives are valid against the swapped legs", validAgainst(snap, base, s1.legs, 1, a1).length === 0, validAgainst(snap, base, s1.legs, 1, a1).join("; "));
  const s2 = applyLegSwap(snap, base, s1, 1, a1.otherGames[0].pick.pickId, NOW)!;
  check("Other games swap: leg 2's game leaves, the new game comes in", !s2.legs.some((l) => l.gameId === s1.legs[1].gameId) && s2.legs[1].gameId === a1.otherGames[0].gameId);
  const s3 = applyLegSwap(snap, base, s2, 0, r1.thisGame[0].pick.pickId, NOW)!;
  const a3 = legAlternatives(snap, base, s3.legs, 2, NOW);
  check("three swaps in: alternatives still valid", validAgainst(snap, base, s3.legs, 2, a3).length === 0, validAgainst(snap, base, s3.legs, 2, a3).join("; "));
  check("a pick that isn't an alternative is refused", applyLegSwap(snap, base, s3, 0, s3.legs[1].pick.pickId, NOW) === null && applyLegSwap(snap, base, s3, 0, "g0low", NOW) === null);
  check("the Regenerate history is untouched by a swap", s3.generatedKey === p0.generatedKey && s3.historyIds.join() === p0.historyIds.join());

  // ---- Combined price, SGP and no-odds ----
  const price = (p: GeneratedParlay) => combineOdds(p.legs.map((l) => l.pick));
  const manual = (p: GeneratedParlay) => p.legs.reduce((d, l) => d * (l.pick.odds > 0 ? 1 + l.pick.odds / 100 : 1 + 100 / -l.pick.odds), 1);
  const c3 = price(s3);
  check("combined price: combineOdds on the current legs", c3.status === "AVAILABLE" && Math.abs(c3.decimal - manual(s3)) < 1e-9, JSON.stringify(c3));
  const sgp4: GeneratorSettings = { ...base, legCount: 4, maxLegsPerGame: 2 };
  const pairSnap = snapshotOf(["g0h", "g0o"]);
  const pp = buildGeneratedParlay(pairSnap, sgp4, null, NOW);
  const pi = pp.legs.findIndex((l) => l.pick.pickId === "g0o");
  const pa = legAlternatives(pairSnap, sgp4, pp.legs, pi, NOW);
  const pb = applyLegSwap(pairSnap, sgp4, pp, pi, pa.otherGames[0].pick.pickId, NOW)!;
  check("a slip pair on G0: Priced at FanDuel before (sameGameGames 1), priced after an Other-games swap (0)", pp.sameGameGames === 1 && pb.sameGameGames === 0 && price(pb).status === "AVAILABLE");
  check("a swapped-out slip pick is listed as not used; slip counts follow", pb.fromSlip === 1 && pb.slipUsed === 1 && pb.generated === 3 && pb.dropped.some((d) => d.pickId === "g0o" && d.reason === "not_selected"));
  // No odds: a pick with no usable price swapped in makes the price Unavailable, swapped back out, priced again.
  const noOdds = PICKS.map((p) => (p.pickId === "g4h" ? { ...p, odds: 0 } : p));
  const snapNo = snapshotOf([], [], noOdds);
  const pn = buildGeneratedParlay(snapNo, base, null, NOW);
  const iNo = 2;
  const an = legAlternatives(snapNo, base, pn.legs, iNo, NOW);
  const withNo = an.otherGames.find((l) => l.pick.pickId === "g4h");
  check("fixture: the no-odds pick is an Other-games alternative", Boolean(withNo), ids(an.otherGames).join(","));
  if (withNo) {
    const sn = applyLegSwap(snapNo, base, pn, iNo, "g4h", NOW)!;
    check("no-odds swap in: Unavailable", combineOdds(sn.legs.map((l) => l.pick)).status === "UNAVAILABLE");
    const back = legAlternatives(snapNo, base, sn.legs, iNo, NOW).thisGame.concat(legAlternatives(snapNo, base, sn.legs, iNo, NOW).otherGames).find((l) => l.pick.odds !== 0)!;
    const sb = applyLegSwap(snapNo, base, sn, iNo, back.pick.pickId, NOW)!;
    check("no-odds swap out: priced again", combineOdds(sb.legs.map((l) => l.pick)).status === "AVAILABLE");
  }

  // ---- Hedge / Contrarian: the build's, never rebuilt by a swap ----
  check("Hedge / Contrarian after swaps are the build's", JSON.stringify(s3.hedge) === JSON.stringify(p0.hedge) && JSON.stringify(s3.contrarian) === JSON.stringify(p0.contrarian));
  check("before any swap, Hedge is the build's own", JSON.stringify(p0.hedge) === JSON.stringify(buildGeneratedParlay(snap, base, null, NOW).hedge));

  // ---- Your picks only ----
  const slipIds = ["g0h", "g1o", "g2h", "g3u", "g4low", "g5a"];
  const ys = snapshotOf(slipIds);
  const yset: GeneratorSettings = { ...base, fillFrom: "YOUR_PICKS_ONLY", legCount: 3 };
  const py = buildGeneratedParlay(ys, yset, null, NOW);
  const ay = legAlternatives(ys, yset, py.legs, 0, NOW);
  check("Your picks only: alternatives are unused slip picks only", all(ay).length > 0 && all(ay).every((l) => slipIds.includes(l.pick.pickId) && !py.legs.some((x) => x.pick.pickId === l.pick.pickId)), ids(all(ay)).join(","));
  check("Your picks only: ungated (the below-gate slip pick is offered)", !py.legs.some((l) => l.pick.pickId === "g4low") && all(ay).some((l) => l.pick.pickId === "g4low"));
  check("Your picks only: split by game the same way", validAgainst(ys, yset, py.legs, 0, ay).length === 0, validAgainst(ys, yset, py.legs, 0, ay).join("; "));
  const yIn = ay.otherGames[0];
  const sy = applyLegSwap(ys, yset, py, 0, yIn.pick.pickId, NOW)!;
  check("Your picks only: the swap moves the pick out of 'not used', the old one in", sy.legs[0].source === "SLIP" && sy.legs[0].handSwapped === true && !sy.dropped.some((d) => d.pickId === yIn.pick.pickId) && sy.dropped.some((d) => d.pickId === py.legs[0].pick.pickId && d.reason === "not_selected"));

  // ---- A game that started since the snapshot ----
  const started = "2099-06-01T11:00:00.000Z";
  const early = PICKS.map((p) => (p.gameId === "G5" ? { ...p, gameTime: started } : p));
  const se = { ...snapshotOf([], [], early), builtAt: "2099-06-01T10:00:00.000Z" };
  const pe = buildGeneratedParlay(se, base, null, new Date("2099-06-01T10:00:00.000Z"));
  const ae = legAlternatives(se, base, pe.legs, 0, NOW);
  check("started since the snapshot, not targeted, no slip pick: not offered", !all(ae).some((l) => l.gameId === "G5"), ids(all(ae)).join(","));
  const seT = { ...snapshotOf([], ["G5", ...pe.legs.map((l) => l.gameId)], early), builtAt: se.builtAt };
  const peT = buildGeneratedParlay(seT, base, null, new Date("2099-06-01T10:00:00.000Z"));
  const aeT = legAlternatives(seT, base, peT.legs, 0, NOW);
  check("started since the snapshot but targeted: offered", all(aeT).some((l) => l.gameId === "G5"), ids(all(aeT)).join(","));
  const seS = { ...snapshotOf(["g5u"], [], early), builtAt: se.builtAt };
  const peS = buildGeneratedParlay(seS, { ...base, maxLegsPerGame: 2 }, null, new Date("2099-06-01T10:00:00.000Z"));
  const g5Index = peS.legs.findIndex((l) => l.gameId === "G5");
  const aeS = legAlternatives(seS, { ...base, maxLegsPerGame: 2 }, peS.legs, g5Index, NOW);
  check("started since the snapshot, a slip pick's game: its picks are offered", aeS.thisGame.length > 0, ids(aeS.thisGame).join(","));

  // ---- The session: no request for a swap, Regenerate clears handSwapped ----
  let clock = NOW;
  let requests = 0;
  const session = createGeneratorSession({
    now: () => clock,
    firstSeed: 7,
    generate: async (req) => {
      requests++;
      const s = { ...snapshotOf(req.slipPickIds), builtAt: clock.toISOString() };
      return { snapshot: s, parlay: buildGeneratedParlay(s, req.settings, null, clock) };
    },
    reuse: { userId: () => "u1", store: null },
  });
  const inputs = { leagues: ["MLB"], slipPickIds: [], targets: [] };
  const g = await session.generate(inputs, base);
  if ("error" in g) throw new Error(g.error);
  clock = new Date(NOW.getTime() + 10 * 60 * 1000); // stale: older than SNAPSHOT_MAX_AGE_MS
  const sa = session.swapOptions(g.parlay, 0, base);
  const swapped = session.swapLeg(g.parlay, 0, optionIds(sa)[0], base);
  check("session: a swap on a stale snapshot makes no request", requests === 1 && swapped !== null && swapped.legs[0].handSwapped === true, `requests=${requests}`);
  const rg = await session.regenerate(inputs, base);
  if ("error" in rg) throw new Error(rg.error);
  check("session: Regenerate rebuilds with no handSwapped leg", rg.parlay.legs.every((l) => !l.handSwapped));
  if (rg.parlay.variety !== "NO_ALTERNATIVE") {
    const ra = session.swapOptions(rg.parlay, 0, base);
    const rs = session.swapLeg(rg.parlay, 0, optionIds(ra)[0], base)!;
    check("session: after a Regenerate, a swap changes only that leg", rs.legs.slice(1).every((l, i) => l.pick.pickId === rg.parlay.legs[i + 1].pick.pickId) && rs.legs[0].handSwapped === true);
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
