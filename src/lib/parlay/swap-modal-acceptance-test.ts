// Proof for the Swap modal's four tabs (legSwapOptions / applyLegSwap in generator.ts,
// classifySwapCandidate in swap-classify.ts, the modal's helpers in swap-modal.ts).
// Fixture: an NCAAB leg "William & Mary +5.5" with, on its game, same-side alternate
// lines, the same team's ML, the game total both ways, a player prop, the opposing
// spread (in and past contrarian's tolerance) and the opposing ML; plus picks on
// three games not in the parlay (NBA, NHL, NBA). Pinned:
//   - every candidate lands in exactly the right tab (or none), the leg leads Primary as current;
//   - Hedge's both-can-win note for the dog's spread vs the favorite's ML;
//   - Other games: every eligible pick, several per game, ranking order; never a parlay game;
//   - counts equal rows (tabs and league chips);
//   - the gates: below-gate picks, the star, same-game conflicts with the other legs, max legs per game;
//   - applyLegSwap replaces only that leg, refuses the current pick / an unclassified pick,
//     leaves Hedge / Contrarian as built, and the combined price recomputes;
//   - classifySwapCandidate on props (same player alt line, contrarian, another player / stat, prop vs side);
//   - generation itself is unchanged: buildGeneratedParlay's legs are the same with or without the modal.
// Pure - no DB. Run with:
//   node --require ./scripts/server-only-stub.cjs --import tsx src/lib/parlay/swap-modal-acceptance-test.ts
import { applyLegSwap, buildGeneratedParlay, legAlternatives, legSwapOptions, SWAP_TAB_KEYS, type EngineLeg, type GeneratedParlay, type GeneratorSettings, type GeneratorSnapshot, type LegSwapOptions, type SwapTabKey } from "@/lib/parlay/generator";
import type { GeneratorGame, GeneratorPick } from "@/lib/parlay/auto-generate";
import { classifySwapCandidate } from "@/lib/parlay/swap-classify";
import { leagueChips, priceView, strengthOrder, swapComparison, tabRows, winTier, isHot } from "@/lib/parlay/swap-modal";
import { combineOdds, payoutOn } from "@/lib/parlay/combine-odds";
import { sameGameConflict } from "@/lib/parlay/same-game-rules";
import { toParlayCandidate, toParlayLeg } from "@/lib/parlay/qualification-core";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const NOW = new Date("2099-03-01T12:00:00.000Z");
const LATER = "2099-03-01T23:00:00.000Z";
type G = { id: string; league: string; home: string; away: string };
const GAMES: G[] = [
  { id: "G0", league: "NCAAB", home: "Florida Atlantic Owls", away: "William & Mary Tribe" },
  { id: "G1", league: "NBA", home: "Boston Celtics", away: "Los Angeles Lakers" },
  { id: "G2", league: "NHL", home: "Boston Bruins", away: "New York Rangers" },
  { id: "G3", league: "NBA", home: "New York Knicks", away: "Chicago Bulls" },
  { id: "G4", league: "MLB", home: "New York Yankees", away: "Boston Red Sox" },
];
const categoryRecords: GeneratorSnapshot["categoryRecords"] = {};
type Spec = { betType: string; detail: string; line?: number | null; odds?: number; category: string; wins: number; favorite?: boolean; period?: string };
function mk(id: string, gi: number, s: Spec): GeneratorPick {
  const g = GAMES[gi];
  categoryRecords["cap-" + id + "|" + s.category] = { key: s.category, label: s.category, wins: s.wins, losses: 40 - s.wins, pushes: 0, winPct: (s.wins / 40) * 100, count: 40 } as never;
  return {
    pickId: id, capperId: "cap-" + id, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: s.favorite === true, category: s.category, leagueName: g.league,
    gameId: g.id, gameLabel: g.away + " @ " + g.home, betDetail: s.detail, odds: s.odds ?? -110, units: 1, status: "PENDING",
    betType: s.betType, period: s.period ?? "FULL_GAME", rawBetDetail: s.detail, line: s.line ?? null,
    homeTeam: g.home, awayTeam: g.away, gameTime: LATER, teamGroup: "HOME", teamLabel: "", teamColor: null, datePosted: "2099-02-28T00:00:00.000Z",
  } as GeneratorPick;
}
const spread = (detail: string, line: number, wins: number, extra: Partial<Spec> = {}): Spec => ({ betType: "SPREAD", detail, line, category: line > 0 ? "SPREAD_PLUS" : "SPREAD_MINUS", wins, ...extra });
const ml = (detail: string, odds: number, wins: number, extra: Partial<Spec> = {}): Spec => ({ betType: "MONEYLINE", detail, odds, category: odds > 0 ? "DOG_ML" : "FAV_ML", wins, ...extra });
const total = (detail: string, line: number, wins: number, extra: Partial<Spec> = {}): Spec => ({ betType: "TOTAL", detail, line, category: detail.startsWith("Over") ? "OVER" : "UNDER", wins, ...extra });

const PICKS: GeneratorPick[] = [
  // G0: the leg and everything on its game.
  mk("leg", 0, spread("William & Mary Tribe +5.5", 5.5, 30)),
  mk("wm45", 0, spread("William & Mary Tribe +4.5", 4.5, 31)),
  mk("wm65", 0, spread("William & Mary Tribe +6.5", 6.5, 29, { favorite: true })),
  mk("wmml", 0, ml("William & Mary Tribe ML", 190, 28)),
  mk("over", 0, total("Over 140.5", 140.5, 32)),
  mk("under", 0, total("Under 140.5", 140.5, 30)),
  mk("prop", 0, { betType: "PLAYER_PROP", detail: "John Smith Over 15.5 Points", line: 15.5, category: "OTHER_PROP", wins: 30 }),
  mk("fau55", 0, spread("Florida Atlantic Owls -5.5", -5.5, 31)),
  mk("fauml", 0, ml("Florida Atlantic Owls ML", -240, 37)),
  mk("fau125", 0, spread("Florida Atlantic Owls -12.5", -12.5, 32)),
  mk("wmlow", 0, spread("William & Mary Tribe +3.5", 3.5, 8)),
  // Games not in the parlay.
  mk("lalml", 1, ml("Los Angeles Lakers ML", 150, 30)),
  mk("bosover", 1, total("Over 228.5", 228.5, 33, { favorite: true })),
  mk("nyrml", 2, ml("New York Rangers ML", 120, 29)),
  mk("nhlover", 2, total("Over 5.5", 5.5, 28)),
  mk("chiml", 3, ml("Chicago Bulls ML", 160, 31)),
  mk("chiml2", 3, ml("Chicago Bulls ML", 155, 27)),
  mk("nbalow", 3, total("Under 220.5", 220.5, 9)),
  // G4: the parlay's other leg, and a pick on it (a parlay game: never in Other games).
  mk("nyy", 4, ml("New York Yankees ML", -130, 33)),
  mk("bosml", 4, ml("Boston Red Sox ML", 115, 30)),
];
const byId = new Map(PICKS.map((p) => [p.pickId, p]));
const games: GeneratorGame[] = GAMES.map((g) => ({ gameId: g.id, gameLabel: g.away + " @ " + g.home, gameTime: LATER, leagueName: g.league, picks: PICKS.filter((p) => p.gameId === g.id) }));
const snap: GeneratorSnapshot = { builtAt: NOW.toISOString(), games, slipPicks: [], targets: [], leagueRecords: { records: {}, streaks: {}, last20: {} }, categoryRecords };
const base: GeneratorSettings = { legCount: 2, maxLegsPerGame: 2, include: ["ALL"] as never, mix: null, fillFrom: "BEST_AVAILABLE", minWinPct: 55 };

// The legs as a build would show them, hand-made so the fixture decides which pick is the leg.
const asLeg = (id: string): EngineLeg => {
  const p = byId.get(id)!;
  const w = Number(categoryRecords["cap-" + id + "|" + p.category]!.wins);
  return { pick: p, gameId: p.gameId, gameLabel: p.gameLabel, gameTime: p.gameTime, source: "GENERATED", record: { wins: w, losses: 40 - w, n: 40, winPct: (w / 40) * 100 }, basis: "OVERALL", wilsonLowerBound: 0.5, score: w, sameGame: false };
};
const parlayOf = (legIds: string[], settings = base): GeneratedParlay => ({ ...buildGeneratedParlay(snap, settings, null, NOW), legs: legIds.map(asLeg) });
const ids = (ls: { pick: { pickId: string } }[]) => ls.map((l) => l.pick.pickId);
const tabOf = (o: LegSwapOptions, id: string): SwapTabKey[] => SWAP_TAB_KEYS.filter((t) => o[t].some((r) => r.pick.pickId === id));
const asC = (p: GeneratorPick) => toParlayCandidate(toParlayLeg(p));
const sorted = (xs: string[]) => [...xs].sort().join(",");

function main() {
  // ---- Tabs -------------------------------------------------------------------
  const p = parlayOf(["leg", "nyy"]);
  const o = legSwapOptions(snap, base, p.legs, 0, NOW);
  const where = (id: string) => tabOf(o, id).join("|") || "none";
  check("the leg leads Primary, marked current", o.PRIMARY[0]?.pick.pickId === "leg" && o.PRIMARY[0].current === true && o.PRIMARY.filter((r) => r.current).length === 1);
  check("Primary: same-side alternate lines (+4.5, +6.5)", where("wm45") === "PRIMARY" && where("wm65") === "PRIMARY", `${where("wm45")} ${where("wm65")}`);
  check("Hedge: the same team's ML for a spread leg (R1 across markets: another market on the game)", where("wmml") === "HEDGE", where("wmml"));
  check("Hedge: the game total, both ways", where("over") === "HEDGE" && where("under") === "HEDGE", `${where("over")} ${where("under")}`);
  check("Hedge: a same-game player prop", where("prop") === "HEDGE", where("prop"));
  check("Contrarian: the opposing team's ML (another side market), though it is the favorite", where("fauml") === "CONTRARIAN", where("fauml"));
  check("Contrarian: the opposing team's spread, and the literal inverse (-5.5)", where("fau55") === "CONTRARIAN" && sorted(ids(o.CONTRARIAN)) === "fau125,fau55,fauml", ids(o.CONTRARIAN).join(","));
  check("the opposing team's spread past contrarian's tolerance (-12.5) is placed by team: Contrarian", where("fau125") === "CONTRARIAN", where("fau125"));
  const low = o.PRIMARY.find((r) => r.pick.pickId === "wmlow");
  check("below the gate: the same-side alternate line is in Primary, marked, after every row that clears", where("wmlow") === "PRIMARY" && low?.belowGate?.gate === 55 && o.PRIMARY[o.PRIMARY.length - 1].pick.pickId === "wmlow", JSON.stringify(low?.belowGate));
  check("every row carries its combined win %", (["PRIMARY", "HEDGE", "CONTRARIAN", "OTHER_GAMES"] as const).every((t) => o[t].every((r) => typeof r.combinedWinPct === "number")));
  check("each candidate is in at most one tab", PICKS.every((x) => tabOf(o, x.pickId).length <= 1));
  const note = o.CONTRARIAN.find((r) => r.pick.pickId === "fauml")?.note;
  check("Both-can-win note (on the opposing ML row): both hit if the favorite wins by 1–5 (+5.5)", note === "Can win with your pick: both hit if Florida Atlantic Owls wins by 1–5", String(note));
  check("the note only where it can be worked out (none on the total or the prop)", [...o.HEDGE, ...o.CONTRARIAN].filter((r) => r.note).length === 1);
  check("Primary keeps the build's ranking after the current pick", ids(o.PRIMARY).slice(1).join() === ids(legAlternatives(snap, base, p.legs, 0, NOW).thisGame.filter((l) => tabOf(o, l.pick.pickId)[0] === "PRIMARY")).join());

  // ---- Other games ----------------------------------------------------------------
  const og = ids(o.OTHER_GAMES);
  check("Other games: every eligible pick, several per game (no one-per-game cut)", sorted(og) === sorted(["lalml", "bosover", "nyrml", "nhlover", "chiml", "chiml2"]), og.join(","));
  check("Other games: never a game in the parlay (G4) or the leg's own game", o.OTHER_GAMES.every((r) => r.gameId !== "G4" && r.gameId !== "G0"));
  check("Other games: best first (score order)", o.OTHER_GAMES.every((r, i, a) => i === 0 || (a[i - 1].score ?? 0) >= (r.score ?? 0)));
  check("Other games: below-gate picks left out", !og.includes("nbalow"));

  // ---- Counts equal rows ------------------------------------------------------------
  check("tab counts are the rows each tab renders", SWAP_TAB_KEYS.every((t) => tabRows(o, t).length === o[t].length));
  const chips = leagueChips(o.OTHER_GAMES);
  check("league chips: All = every Other-games row, then each league present", chips[0].league === null && chips[0].count === o.OTHER_GAMES.length && sorted(chips.slice(1).map((c) => c.league!)) === "NBA,NHL", JSON.stringify(chips));
  check("league chips: each count is that league's rows", chips.slice(1).every((c) => tabRows(o, "OTHER_GAMES", c.league).length === c.count) && chips.slice(1).reduce((n, c) => n + c.count, 0) === chips[0].count);

  // ---- Gates: the star, same-game conflicts, max legs per game -----------------------------
  const fav = legSwapOptions(snap, { ...base, favoritesOnly: true }, p.legs, 0, NOW);
  check("star: only favorite cappers' picks (plus the current leg)", sorted(SWAP_TAB_KEYS.flatMap((t) => ids(fav[t].filter((r) => !r.current)))) === "bosover,wm65");
  const sgp = parlayOf(["leg", "over", "nyy"]);
  const so = legSwapOptions(snap, base, sgp.legs, 0, NOW);
  const soAll = SWAP_TAB_KEYS.flatMap((t) => so[t].filter((r) => !r.current));
  check("same game: the Under opposing the Over leg is not offered", !soAll.some((r) => r.pick.pickId === "under"));
  check("same game: the Over leg itself is not offered", !soAll.some((r) => r.pick.pickId === "over"));
  check("same game: every offer passes the same-game rules against the Over leg", soAll.filter((r) => r.gameId === "G0").every((r) => sameGameConflict(asC(r.pick), asC(byId.get("over")!)) === null));
  const one = legSwapOptions(snap, { ...base, maxLegsPerGame: 1 }, sgp.legs, 0, NOW);
  check("max legs per game 1 with another leg on the game: Primary is only the current, Hedge / Contrarian empty", one.PRIMARY.length === 1 && one.HEDGE.length === 0 && one.CONTRARIAN.length === 0);
  check("max legs per game: the swapped leg doesn't count against its own game", o.HEDGE.length > 0 && legSwapOptions(snap, { ...base, maxLegsPerGame: 1 }, p.legs, 0, NOW).HEDGE.length > 0);

  // ---- applyLegSwap ------------------------------------------------------------------
  const s = applyLegSwap(snap, base, p, 0, "fauml", NOW);
  check("swap: only that leg changes", s !== null && s.legs[0].pick.pickId === "fauml" && JSON.stringify(s.legs[1]) === JSON.stringify(p.legs[1]));
  check("swap: the new leg is handSwapped and carries no modal fields", s!.legs[0].handSwapped === true && !("note" in s!.legs[0]) && !("current" in s!.legs[0]));
  check("swap: Hedge / Contrarian are the build's (not rebuilt)", JSON.stringify(s!.hedge) === JSON.stringify(p.hedge) && JSON.stringify(s!.contrarian) === JSON.stringify(p.contrarian));
  check("swap: the current pick is refused", applyLegSwap(snap, base, p, 0, "leg", NOW) === null);
  check("swap: a below-gate row swaps in, marked below your gate; one the status rule now places (-12.5) is allowed", applyLegSwap(snap, base, p, 0, "wmlow", NOW)?.legs[0].belowGate?.gate === 55 && applyLegSwap(snap, base, p, 0, "fau125", NOW) !== null);
  check("swap: an Other-games pick works, and takes the leg's game out", applyLegSwap(snap, base, p, 0, "chiml2", NOW)?.legs.map((l) => l.gameId).join() === "G3,G4");
  const s2 = applyLegSwap(snap, base, s!, 1, "bosml", NOW);
  check("swap another leg: the first swap stays", s2?.legs[0].pick.pickId === "fauml" && s2?.legs[1].pick.pickId === "bosml");

  // ---- Combined price ------------------------------------------------------------------
  const manual = (legs: EngineLeg[]) => legs.reduce((d, l) => d * (l.pick.odds > 0 ? 1 + l.pick.odds / 100 : 1 + 100 / -l.pick.odds), 1);
  const after = combineOdds(s!.legs.map((l) => l.pick));
  check("combined price after the swap: combineOdds on the current legs", after.status === "AVAILABLE" && Math.abs(after.decimal - manual(s!.legs)) < 1e-9);
  const asPrice = (l: EngineLeg) => ({ odds: l.pick.odds, gameId: l.gameId });
  const cmp = swapComparison(p.legs.map(asPrice), 0, asPrice(asLeg("wmml")));
  const before = combineOdds(p.legs.map((l) => l.pick));
  check(
    "modal footer: now -> with the leg replaced, $10 payout, direction up for a longer price",
    cmp.now.kind === "PRICED" && cmp.next?.kind === "PRICED" && before.status === "AVAILABLE" && Math.abs(cmp.now.payout - payoutOn(before, 10)) < 1e-9 && cmp.direction === "UP",
    JSON.stringify(cmp)
  );
  check("modal footer: direction down for a shorter price", swapComparison(p.legs.map(asPrice), 0, asPrice(asLeg("fauml"))).direction === "DOWN");
  check("modal footer: two legs on one game are priced at FanDuel", priceView([asPrice(asLeg("leg")), asPrice(asLeg("over"))]).kind === "FANDUEL");
  check("modal footer: nothing chosen, no 'new' price", swapComparison(p.legs.map(asPrice), 0, null).next === null);

  // ---- Props (classifySwapCandidate) --------------------------------------------------------
  const nba = (detail: string, betType = "PLAYER_PROP", line: number | null = null) =>
    toParlayCandidate(toParlayLeg({ ...byId.get("lalml")!, betType, rawBetDetail: detail, betDetail: detail, line, pickId: detail }));
  const lebron = nba("LeBron James Over 25.5 Points", "PLAYER_PROP", 25.5);
  check("prop: the same player and stat, same way, another line -> Primary", classifySwapCandidate(lebron, nba("LeBron James Over 27.5 Points", "PLAYER_PROP", 27.5)).tab === "PRIMARY");
  check("prop: the other side of the same prop -> Contrarian", classifySwapCandidate(lebron, nba("LeBron James Under 25.5 Points", "PLAYER_PROP", 25.5)).tab === "CONTRARIAN");
  check("prop: another player -> Hedge", classifySwapCandidate(lebron, nba("Anthony Davis Over 10.5 Rebounds", "PLAYER_PROP", 10.5)).tab === "HEDGE");
  check("prop: the same player, another stat -> Hedge", classifySwapCandidate(lebron, nba("LeBron James Over 7.5 Assists", "PLAYER_PROP", 7.5)).tab === "HEDGE");
  check("prop: a prop against a side with no status known -> Hedge (both ways)", classifySwapCandidate(lebron, nba("Los Angeles Lakers ML", "MONEYLINE")).tab === "HEDGE" && classifySwapCandidate(nba("Los Angeles Lakers ML", "MONEYLINE"), lebron).tab === "HEDGE");

  // ---- Favorite / underdog split (Hedge vs Contrarian) -----------------------------------
  const FAV = { own: "FAVORITE", home: null, away: null } as const;
  const DOG = { own: "UNDERDOG", home: null, away: null } as const;
  const giannis = nba("Giannis Antetokounmpo Under 11.5 Rebounds", "PLAYER_PROP", 11.5);
  check("rule 1: the literal inverse of a prop is Contrarian whatever its status", classifySwapCandidate(giannis, nba("Giannis Antetokounmpo Over 11.5 Rebounds", "PLAYER_PROP", 11.5), FAV).tab === "CONTRARIAN");
  check("rule 2: a prop leg, favorite ML candidate -> Hedge", classifySwapCandidate(giannis, nba("Los Angeles Lakers ML", "MONEYLINE"), FAV).tab === "HEDGE");
  check("rule 2: a prop leg, underdog ML candidate -> Contrarian", classifySwapCandidate(giannis, nba("Los Angeles Lakers ML", "MONEYLINE"), DOG).tab === "CONTRARIAN");
  check("rule 2: a prop leg, favorite / underdog spread candidates", classifySwapCandidate(giannis, nba("Los Angeles Lakers -5.5", "SPREAD", -5.5), FAV).tab === "HEDGE" && classifySwapCandidate(giannis, nba("Los Angeles Lakers +5.5", "SPREAD", 5.5), DOG).tab === "CONTRARIAN");
  check("rule 3: a prop whose text names its team inherits that team's status (home dog -> Contrarian)", classifySwapCandidate(lebron, nba("Celtics Jayson Tatum Over 27.5 Points", "PLAYER_PROP", 27.5), { own: null, home: "UNDERDOG", away: "FAVORITE" }).tab === "CONTRARIAN");
  check("rule 3: ... and a favorite's team's prop -> Hedge", classifySwapCandidate(lebron, nba("Celtics Jayson Tatum Over 27.5 Points", "PLAYER_PROP", 27.5), { own: null, home: "FAVORITE", away: "UNDERDOG" }).tab === "HEDGE");
  check("rule 3: a prop whose team can't be read -> Hedge", classifySwapCandidate(lebron, nba("Jabari Smith Jr Over 15.5 Points", "PLAYER_PROP", 15.5), { own: null, home: "UNDERDOG", away: "UNDERDOG" }).tab === "HEDGE");
  check("rule 4: a game total candidate is Hedge, even with a status around", classifySwapCandidate(giannis, nba("Over 228.5", "TOTAL", 228.5), DOG).tab === "HEDGE");
  check("rule 2 with a team leg: an underdog ML in another market of the game -> Contrarian", classifySwapCandidate(nba("Los Angeles Lakers -5.5", "SPREAD", -5.5), nba("Boston Celtics ML", "MONEYLINE"), DOG).tab === "CONTRARIAN");
  // Team identity beats status: the same team in another scope is Hedge even as the underdog.
  const lakersDog = nba("Los Angeles Lakers +5.5", "SPREAD", 5.5);
  const lakers1h = { ...nba("Los Angeles Lakers +2.5 1H", "SPREAD", 2.5), pick: { ...nba("Los Angeles Lakers +2.5 1H", "SPREAD", 2.5).pick, period: "FIRST_HALF" } };
  check("same team, another scope, underdog -> Hedge (not Contrarian)", classifySwapCandidate(lakersDog, lakers1h, DOG).tab === "HEDGE");
  check("opposing team, favorite -> Contrarian (status not consulted)", classifySwapCandidate(lakersDog, nba("Boston Celtics -5.5", "SPREAD", -5.5), FAV).tab === "CONTRARIAN" && classifySwapCandidate(lakersDog, nba("Boston Celtics ML", "MONEYLINE"), FAV).tab === "CONTRARIAN");
  const lakersProp = nba("Lakers LeBron James Over 25.5 Points", "PLAYER_PROP", 25.5);
  check("prop leg whose team is read: same-team ML (underdog) Hedge, opposing ML (favorite) Contrarian", classifySwapCandidate(lakersProp, nba("Los Angeles Lakers ML", "MONEYLINE"), DOG).tab === "HEDGE" && classifySwapCandidate(lakersProp, nba("Boston Celtics ML", "MONEYLINE"), FAV).tab === "CONTRARIAN");
  check("a game total stays Hedge when the leg's team is known", classifySwapCandidate(lakersDog, nba("Over 228.5", "TOTAL", 228.5), DOG).tab === "HEDGE");
  // Through legSwapOptions: a favorite-ML leg sees the underdog-side picks of its game as Contrarian.
  const fo = legSwapOptions(snap, base, parlayOf(["fauml", "nyy"]).legs, 0, NOW);
  const fw = (id: string) => tabOf(fo, id).join("|") || "none";
  check("favorite-ML leg: underdog spreads (+4.5, +6.5, +5.5) and the dog ML are Contrarian", ["wm45", "wm65", "leg", "wmml"].every((id) => fw(id) === "CONTRARIAN"), ["wm45", "wm65", "leg", "wmml"].map(fw).join(","));
  check("favorite-ML leg: the totals stay Hedge", fw("over") === "HEDGE" && fw("under") === "HEDGE", `${fw("over")} ${fw("under")}`);
  check("prop: the same player the other way, past tolerance -> none", classifySwapCandidate(lebron, nba("LeBron James Under 31.5 Points", "PLAYER_PROP", 31.5)).tab === null);

  // ---- The modal's display helpers ---------------------------------------------------------
  check("win tiers: 70+ strong, 55-69 good, under 55 low, none", [winTier(70), winTier(69.9), winTier(55), winTier(54.9), winTier(null)].join() === "STRONG,GOOD,GOOD,LOW,NONE");
  check("Hot at 75+", isHot(75) && !isHot(74.9) && !isHot(null));
  check("strongest first: by win %, no record last, ties by edge then engine order", strengthOrder([{ record: null, score: 9 }, { record: { wins: 1, losses: 1, n: 2, winPct: 60 }, score: 1 }, { record: { wins: 1, losses: 1, n: 2, winPct: 80 }, score: 1 }, { record: { wins: 1, losses: 1, n: 2, winPct: 60 }, score: 2 }]).join() === "2,3,1,0");

  // ---- Generation unchanged --------------------------------------------------------------
  const g1 = buildGeneratedParlay(snap, { ...base, legCount: 4 }, null, NOW);
  legSwapOptions(snap, base, g1.legs, 0, NOW);
  const g2 = buildGeneratedParlay(snap, { ...base, legCount: 4 }, null, NOW);
  check("Generate is the same before and after the modal reads options", JSON.stringify(g1) === JSON.stringify(g2));

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
