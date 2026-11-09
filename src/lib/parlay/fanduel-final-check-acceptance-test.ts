// Proof for Send to FanDuel's final check before sending (PR C): before any leg is sent, the stored game itself
// has to be believable -
//   1. the stored league is in season (isSportInSeason)
//   2. the stored line is one that league posts (ambiguous-line-plausibility.ts bounds)
//   3. a stored game NOT on the send's slate date (America/Chicago), for a school that also plays another
//      in-season sport, is checked against that sport's free /events listing: a game today for the same school
//      is a question ("Needs clarification" naming both games), never sent, never switched to.
// A blocked leg blocks only itself. The extra listing is asked for once per league per send, and not at all for a
// same-day leg or a name only one league has. Pure: no DB, no network (getEvents / getEventMarkets are fakes that
// count their calls). Run with:
//   npx tsx src/lib/parlay/fanduel-final-check-acceptance-test.ts
import {
  buildFanDuelLink,
  otherLeaguesForTeam,
  slateDateKey,
  storedGameProblem,
  type FanDuelDeps,
  type FanDuelEvent,
  type FanDuelLegInput,
  type FanDuelLegResult,
  type FanDuelMarket,
} from "@/lib/parlay/fanduel-link";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}
const has = (label: string, text: string | null | undefined, parts: string[]) =>
  check(label, parts.filter((p) => !(text ?? "").includes(p)), []);

// Sunday 2026-11-08, 2 PM in Chicago: NCAAF, NCAAB, NHL, NBA and NFL in season; WNBA (ended Nov 1) and MLB (Nov 5) not.
const NOW = new Date("2026-11-08T20:00:00Z");
const TODAY_7PM = "2026-11-09T01:00:00Z"; // Sun Nov 8, 7 PM Chicago
const IN_4_DAYS = "2026-11-12T23:30:00Z"; // Thu Nov 12
const TOMORROW = "2026-11-09T23:00:00Z"; // Mon Nov 9

const NCAAF = "americanfootball_ncaaf";
const NCAAB = "basketball_ncaab";
const NHL = "icehockey_nhl";

const ev = (id: string, sportKey: string, awayTeam: string, homeTeam: string, commenceTime: string): FanDuelEvent => ({ id, sportKey, homeTeam, awayTeam, commenceTime });
const link = (m: string, s: string) => `https://sportsbook.fanduel.com/addToBetslip?marketId=${m}&selectionId=${s}`;

// Every event's FanDuel board: a moneyline and a spread at -6.5/+6.5, the same prices for every game - so "which
// game's price is closer" could never tell two games apart.
function board(e: FanDuelEvent): FanDuelMarket[] {
  const n = e.id.length * 101;
  return [
    {
      key: "h2h",
      sid: null,
      outcomes: [
        { name: e.homeTeam, price: -250, sid: String(n + 1), link: link(n + ".1", String(n + 1)) },
        { name: e.awayTeam, price: 200, sid: String(n + 2), link: link(n + ".1", String(n + 2)) },
      ],
    },
    {
      key: "spreads",
      sid: null,
      outcomes: [
        { name: e.homeTeam, price: -110, point: -6.5, sid: String(n + 3), link: link(n + ".2", String(n + 3)) },
        { name: e.awayTeam, price: -110, point: 6.5, sid: String(n + 4), link: link(n + ".2", String(n + 4)) },
      ],
    },
  ];
}

async function send(legs: FanDuelLegInput[], listings: Record<string, FanDuelEvent[]>) {
  const eventCalls: string[] = [];
  const marketCalls: string[] = [];
  const all = Object.values(listings).flat();
  const deps: FanDuelDeps = {
    now: NOW,
    getEvents: async (k) => {
      eventCalls.push(k);
      return listings[k] ?? [];
    },
    getEventMarkets: async (_s, id, keys) => {
      marketCalls.push(id);
      const e = all.find((x) => x.id === id)!;
      return board(e).filter((m) => keys.includes(m.key));
    },
  };
  const built = await buildFanDuelLink(legs, deps);
  return { ...built, eventCalls, marketCalls, by: Object.fromEntries(built.legs.map((l) => [l.pickId, l])) as Record<string, FanDuelLegResult> };
}

const leg = (pickId: string, over: Partial<FanDuelLegInput>): FanDuelLegInput => ({
  pickId,
  sportKey: NCAAF,
  leagueName: "NCAAF",
  betType: "SPREAD",
  period: "FULL_GAME",
  betDetail: pickId,
  pickedSide: "HOME",
  line: -6.5,
  homeTeam: "Home",
  awayTeam: "Away",
  gameTime: TODAY_7PM,
  odds: -110,
  oddsSource: "STATED",
  onBoard: true,
  ...over,
});

// The production shape: a South Carolina basketball pick stored on the Gamecocks' football game four days out.
const SC_FOOTBALL = ev("scfb", NCAAF, "Texas A&M Aggies", "South Carolina Gamecocks", IN_4_DAYS);
const SC_HOOPS_TODAY = ev("scbb", NCAAB, "Furman Paladins", "South Carolina Gamecocks", TODAY_7PM);
const scLeg = leg("sc", { betDetail: "South Carolina -6.5", homeTeam: SC_FOOTBALL.homeTeam, awayTeam: SC_FOOTBALL.awayTeam, gameTime: IN_4_DAYS });

async function main() {
  console.log("---- helpers ----");
  check("slate date is Chicago's: 7 PM Sunday Chicago is still Sunday (01:00Z Monday)", [slateDateKey(NOW), slateDateKey(TODAY_7PM)], ["2026-11-08", "2026-11-08"]);
  check(
    "a school is in both college leagues; a basketball-only school and a pro team are not",
    [otherLeaguesForTeam("South Carolina Gamecocks", NCAAF), otherLeaguesForTeam("Arkansas State Red Wolves", NCAAB), otherLeaguesForTeam("Gonzaga Bulldogs", NCAAB), otherLeaguesForTeam("Florida Panthers", NHL)],
    [[NCAAB], [NCAAF], [], []]
  );

  console.log("---- 1. South Carolina NCAAB pick stored on an NCAAF game 4 days out ----");
  {
    const r = await send([scLeg], { [NCAAF]: [SC_FOOTBALL], [NCAAB]: [SC_HOOPS_TODAY] });
    check("needs_clarification, not sent", [r.by.sc.status, r.url], ["needs_clarification", null]);
    has("the reason names both candidate games: sport, teams, date", r.by.sc.reason, [
      "NCAAF: Texas A&M Aggies @ South Carolina Gamecocks, Thu, Nov 12",
      "NCAAB: Furman Paladins @ South Carolina Gamecocks, Sun, Nov 8",
    ]);
    check("no FanDuel market was asked for either game (nothing chosen by price)", r.marketCalls, []);
    check("one listing per league: NCAAF (the leg's own) + NCAAB (the slate check), each once", r.eventCalls.sort(), [NCAAF, NCAAB]);
  }

  console.log("---- 2. Arkansas State: wrong date, wrong sport, wrong line ----");
  {
    const fb = ev("asufb", NCAAF, "Arkansas State Red Wolves", "Troy Trojans", "2026-11-14T20:00:00Z");
    const bb = ev("asubb", NCAAB, "Arkansas State Red Wolves", "Memphis Tigers", TODAY_7PM);
    const wrongDate = leg("asu-date", { betDetail: "Arkansas State ML", betType: "MONEYLINE", line: null, pickedSide: "AWAY", homeTeam: fb.homeTeam, awayTeam: fb.awayTeam, gameTime: fb.commenceTime, odds: 200 });
    const r = await send([wrongDate], { [NCAAF]: [fb], [NCAAB]: [bb] });
    check("stored on a football game 6 days out while the school plays basketball today: needs_clarification", [r.by["asu-date"].status, r.url], ["needs_clarification", null]);
    has("...naming both games", r.by["asu-date"].reason, ["NCAAF: Arkansas State Red Wolves @ Troy Trojans, Sat, Nov 14", "NCAAB: Arkansas State Red Wolves @ Memphis Tigers, Sun, Nov 8"]);

    const wrongSport = leg("asu-wnba", { sportKey: "basketball_wnba", leagueName: "WNBA", betDetail: "Arkansas State -4.5", line: -4.5, homeTeam: "Arkansas State Red Wolves", awayTeam: "Memphis Tigers" });
    const r2 = await send([wrongSport], { [NCAAB]: [bb] });
    check("stored as a WNBA game (season over): needs_clarification, and no listing is read for it", [r2.by["asu-wnba"].status, r2.eventCalls, r2.marketCalls], ["needs_clarification", [], []]);
    has("...saying the league isn't in season", r2.by["asu-wnba"].reason, ["WNBA isn't in season"]);
    check("storedGameProblem: MLB after the World Series is out of season too", storedGameProblem(leg("mlb", { sportKey: "baseball_mlb", leagueName: "MLB", line: -1.5 }), NOW)?.includes("MLB isn't in season"), true);

    const wrongLine = leg("asu-line", { betType: "TOTAL", betDetail: "Arkansas State over 145.5", line: 145.5, pickedSide: null, homeTeam: fb.homeTeam, awayTeam: fb.awayTeam, gameTime: fb.commenceTime });
    const r3 = await send([wrongLine], { [NCAAF]: [fb], [NCAAB]: [bb] });
    check("a basketball total (145.5) stored on a football game: needs_clarification before any listing", [r3.by["asu-line"].status, r3.eventCalls], ["needs_clarification", []]);
    has("...naming the line and the league", r3.by["asu-line"].reason, ["a total of 145.5 isn't a real NCAAF line"]);
    check("a first-half total is not held to the full-game minimum", storedGameProblem(leg("h1", { betType: "TOTAL", period: "FIRST_HALF", line: 13.5 }), NOW), null);
  }

  console.log("---- 3. A normal same-day leg passes with zero extra listings ----");
  {
    const game = ev("bama", NCAAF, "Auburn Tigers", "Alabama Crimson Tide", TODAY_7PM);
    const sameDay = leg("same-day", { betDetail: "Alabama -6.5", homeTeam: game.homeTeam, awayTeam: game.awayTeam });
    const r = await send([sameDay], { [NCAAF]: [game], [NCAAB]: [ev("bamabb", NCAAB, "Auburn Tigers", "Alabama Crimson Tide", TODAY_7PM)] });
    check("a school on today's slate is sent (even with a basketball game today too)", [r.by["same-day"].status, r.url !== null], ["matched", true]);
    check("only its own league's listing was read: zero extra", r.eventCalls, [NCAAF]);

    const nhlGame = ev("nhl", NHL, "Boston Bruins", "Toronto Maple Leafs", TODAY_7PM);
    const nhlLeg = leg("nhl", { sportKey: NHL, leagueName: "NHL", betType: "MONEYLINE", line: null, odds: -250, betDetail: "Leafs ML", homeTeam: nhlGame.homeTeam, awayTeam: nhlGame.awayTeam });
    const r2 = await send([nhlLeg], { [NHL]: [nhlGame] });
    check("a pro leg today: matched, one listing", [r2.by.nhl.status, r2.eventCalls], ["matched", [NHL]]);

    const gonzaga = ev("zags", NCAAB, "Oregon Ducks", "Gonzaga Bulldogs", TOMORROW);
    const zagsLeg = leg("zags", { sportKey: NCAAB, leagueName: "NCAAB", betDetail: "Gonzaga -6.5", homeTeam: gonzaga.homeTeam, awayTeam: gonzaga.awayTeam, gameTime: TOMORROW });
    const r3 = await send([zagsLeg], { [NCAAB]: [gonzaga] });
    check("tomorrow's game for a basketball-only school: sent, and no other league is listed", [r3.by.zags.status, r3.eventCalls], ["matched", [NCAAB]]);

    const tomorrowFb = ev("ttu", NCAAF, "Baylor Bears", "Texas Tech Red Raiders", TOMORROW);
    const tomorrowLeg = leg("ttu", { betDetail: "Texas Tech -6.5", homeTeam: tomorrowFb.homeTeam, awayTeam: tomorrowFb.awayTeam, gameTime: TOMORROW });
    const r4 = await send([tomorrowLeg], { [NCAAF]: [tomorrowFb], [NCAAB]: [] });
    check("tomorrow's football game, school not playing basketball today: sent (one free listing checked)", [r4.by.ttu.status, r4.eventCalls.sort()], ["matched", [NCAAF, NCAAB]]);
  }

  console.log("---- 4. Two events with similar odds don't auto-pass; a blocked leg blocks only itself ----");
  {
    // Both South Carolina games carry the identical FanDuel board: price can't separate them, and isn't asked.
    const nhlGame = ev("nhl", NHL, "Boston Bruins", "Toronto Maple Leafs", TODAY_7PM);
    const nhlLeg = leg("nhl", { sportKey: NHL, leagueName: "NHL", betType: "MONEYLINE", line: null, odds: -250, betDetail: "Leafs ML", homeTeam: nhlGame.homeTeam, awayTeam: nhlGame.awayTeam });
    const r = await send([scLeg, nhlLeg], { [NCAAF]: [SC_FOOTBALL], [NCAAB]: [SC_HOOPS_TODAY], [NHL]: [nhlGame] });
    check("South Carolina: still needs_clarification with identical prices on both games", r.by.sc.status, "needs_clarification");
    check("neither South Carolina game's markets were read; only the NHL leg's", r.marketCalls, ["nhl"]);
    check("the other leg still sends: the link carries the NHL leg alone", [r.by.nhl.status, (r.url?.match(/selectionId/g) ?? []).length], ["matched", 1]);

    const twoToday = [SC_HOOPS_TODAY, ev("scbb2", NCAAB, "South Carolina Gamecocks", "Clemson Tigers", "2026-11-09T03:00:00Z")];
    const r2 = await send([scLeg], { [NCAAF]: [SC_FOOTBALL], [NCAAB]: twoToday });
    check("two same-name games today: still a question, never a pick between them", r2.by.sc.status, "needs_clarification");
    has("...naming every candidate", r2.by.sc.reason, ["Furman Paladins @ South Carolina Gamecocks", "South Carolina Gamecocks @ Clemson Tigers"]);
  }

  console.log("---- 5. Batching, feed failure, live legs ----");
  {
    const ttuFb = ev("ttu", NCAAF, "Baylor Bears", "Texas Tech Red Raiders", TOMORROW);
    const a = leg("a", { homeTeam: SC_FOOTBALL.homeTeam, awayTeam: SC_FOOTBALL.awayTeam, gameTime: IN_4_DAYS });
    const b = leg("b", { betDetail: "Texas Tech -6.5", homeTeam: ttuFb.homeTeam, awayTeam: ttuFb.awayTeam, gameTime: TOMORROW });
    const r = await send([a, b], { [NCAAF]: [SC_FOOTBALL, ttuFb], [NCAAB]: [SC_HOOPS_TODAY] });
    check("two off-slate college legs: the NCAAB listing is read once for the whole send", r.eventCalls.filter((k) => k === NCAAB).length, 1);
    check("...each leg judged on its own (a: question, b: sent)", [r.by.a.status, r.by.b.status], ["needs_clarification", "matched"]);

    const down: FanDuelDeps = {
      now: NOW,
      getEvents: async (k) => (k === NCAAB ? null : [SC_FOOTBALL]),
      getEventMarkets: async () => board(SC_FOOTBALL),
    };
    const r2 = await buildFanDuelLink([scLeg], down);
    check("the other league's listing unreadable: not sent, and not called a match either", [r2.legs[0].status, r2.url], ["error", null]);

    // A live leg (kicked off an hour ago) still goes through every check; only its price gap is relaxed.
    const liveLine = leg("live", { betType: "TOTAL", line: 145.5, pickedSide: null, gameTime: "2026-11-08T19:00:00Z" });
    const r3 = await send([liveLine], { [NCAAF]: [ev("live", NCAAF, "Away", "Home", "2026-11-08T19:00:00Z")] });
    check("live leg with a basketball total on a football game: needs_clarification", r3.by.live.status, "needs_clarification");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
