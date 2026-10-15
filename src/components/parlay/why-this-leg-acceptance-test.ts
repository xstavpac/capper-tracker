// Proof of every parlay leg's "Why this leg?" and each build's "Excluded from
// your slip" list:
//   - a leg's why names its capper, the record it was ranked on, which fallback
//     that record came from (none for the league's own record), and its sample
//     size as-is - a 1-pick sample is shown, not hidden;
//   - it is collapsed by default;
//   - a locked leg says Locked;
//   - an alternate's leg that isn't its game's #1 says where it ranked
//     ("Game's #2 pick"), and that rank is the pick's real place in its game;
//   - the Excluded list shows each slip item with the build's own reason, and
//     renders nothing when nothing was excluded.
//
// The real components are rendered to markup and read on a jsdom document.
// Run: npx tsx src/components/parlay/why-this-leg-acceptance-test.ts
// Exits non-zero if any assertion fails.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import type { LegWhy } from "@/components/parlay/swap-result";
import type { AutoParlay, GeneratorGame, GeneratorPick, RankedPick } from "@/lib/parlay/auto-generate";
import type { BuildCandidate } from "@/lib/parlay/build-my-picks";
import type { CapperLeagueRecords } from "@/server/data/picks";

// The leg row's "+ Add game" reads the slip context, which imports a server
// action - replaced, as in the other parlay component tests.
function stub(relativePath: string, exports: Record<string, unknown>) {
  const path = require.resolve(relativePath);
  require.cache[path] = { id: path, filename: path, loaded: true, exports } as unknown as NodeJS.Module;
}
stub("../../server/actions/parlay-slip", { getSlipPickStatesAction: async () => ({}) });
// tsx compiles the components' JSX to React.createElement (tsconfig "jsx": "preserve"), with no import of its own.
(globalThis as Record<string, unknown>).React = require("react");
const { ExcludedFromSlip, LegRow, rankedRecordText, rankedWhy, skippedAsExcluded } = require("./swap-result") as typeof import("./swap-result");
const { rankGamePicks } = require("../../lib/parlay/auto-generate") as typeof import("../../lib/parlay/auto-generate");
const { buildParlaySet, EMPTY_SLIP } = require("../../lib/parlay/alternates") as typeof import("../../lib/parlay/alternates");
const { selectConflictFreeLegs } = require("../../lib/parlay/build-my-picks") as typeof import("../../lib/parlay/build-my-picks");

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const FUTURE = "2099-01-01T00:00:00.000Z";
function pick(id: string, game: number): GeneratorPick {
  const home = "Home" + game;
  const away = "Away" + game;
  return {
    pickId: id, capperId: "capper-" + id, capperName: "Capper " + id, capperColorTag: null, capperIsFavorite: false,
    category: "SPREAD", leagueName: "NFL", gameId: "game" + game, gameLabel: away + " @ " + home, betDetail: home + " -3",
    odds: -110, units: 1, status: "PENDING", betType: "SPREAD", period: "FULL_GAME", rawBetDetail: home + " -3", line: -3,
    homeTeam: home, awayTeam: away, gameTime: FUTURE, teamGroup: "HOME", teamLabel: home, teamColor: null,
    datePosted: "2098-12-31T00:00:00.000Z",
  };
}

const rec = (wins: number, losses: number) => ({ wins, losses, winPct: (wins / (wins + losses)) * 100, count: wins + losses });
const none = { wins: 0, losses: 0, winPct: 0, count: 0 };
const card = (league: ReturnType<typeof rec> | typeof none, overall: ReturnType<typeof rec> | typeof none) =>
  ({ league, overall }) as unknown as NonNullable<CapperLeagueRecords["records"][string]>;
const key = (p: GeneratorPick) => p.capperId + "|" + p.leagueName + "|" + p.category;

// league: 14-6 in NFL spreads. overall: no NFL record, 9-6 all leagues.
// last20: nothing in this market at all, 11-9 last 20. thin: one graded pick.
const LEAGUE = pick("league", 1);
const OVERALL = pick("overall", 2);
const LAST20 = pick("last20", 3);
const THIN = pick("thin", 4);
const NONE = pick("none", 5);
const RECORDS: CapperLeagueRecords = {
  records: {
    [key(LEAGUE)]: card(rec(14, 6), rec(30, 20)),
    [key(OVERALL)]: card(none, rec(9, 6)),
    [key(THIN)]: card(rec(1, 0), rec(1, 0)),
  },
  streaks: {},
  last20: { [LAST20.capperId]: rec(11, 9) },
} as unknown as CapperLeagueRecords;

const ranked = (p: GeneratorPick): RankedPick => rankGamePicks([p], RECORDS)[0];

function render(element: Parameters<typeof renderToStaticMarkup>[0]): Document {
  return new JSDOM("<!doctype html><body>" + renderToStaticMarkup(element) + "</body>").window.document;
}
function legDoc(r: RankedPick, extra: Pick<LegWhy, "locked" | "gameRank"> = {}): Document {
  return render(
    createElement("ol", null, createElement(LegRow, { n: 1, pick: r.pick, recordText: rankedRecordText(r), winPct: r.record?.winPct ?? null, why: rankedWhy(r, extra) }))
  );
}
// The why panel's text, as "Term: value" lines.
function whyText(doc: Document): string {
  const dts = Array.from(doc.querySelectorAll("details dl dt"));
  return dts.map((dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent ?? ""}`).join(" | ");
}
const tagsOf = (doc: Document) =>
  Array.from(doc.querySelectorAll("details > div > div span")).map((s) => s.textContent);

// ---- 1. Capper, record, fallback, sample -----------------------------------
{
  const doc = legDoc(ranked(LEAGUE));
  const details = doc.querySelector("details");
  check("why: a 'Why this leg?' line under the leg", details?.querySelector("summary")?.textContent?.includes("Why this leg?") === true);
  check("why: collapsed by default", details !== null && !details.hasAttribute("open"));
  const text = whyText(doc);
  check("why: capper name", text.includes("Capper: Capper league"), text);
  check("why: the league record it was ranked on, with its market", text.includes("Record: 70% (14–6) · NFL spread"), text);
  check("why: the league's own record carries no fallback label", !text.includes("Fallback"), text);
  check("why: sample size is the record's graded picks", text.includes("Sample: 20 graded picks"), text);
  check("why: no Locked or game-rank tag on a plain leg", tagsOf(doc).length === 0, JSON.stringify(tagsOf(doc)));
}
{
  const text = whyText(legDoc(ranked(OVERALL)));
  check("why: all-leagues fallback is labeled", text.includes("Record: 60% (9–6) · all leagues spread") && text.includes("Fallback: all leagues"), text);
  check("why: ...with that record's own sample", text.includes("Sample: 15 graded picks"), text);
}
{
  const text = whyText(legDoc(ranked(LAST20)));
  check("why: last-20 fallback is labeled", text.includes("last 20, all markets") && text.includes("Fallback: last 20"), text);
  check("why: ...sample 20", text.includes("Sample: 20 graded picks"), text);
}
{
  const text = whyText(legDoc(ranked(THIN)));
  check("why: a one-pick sample is shown as-is, not hidden", text.includes("Sample: 1 graded pick") && text.includes("100% (1–0)"), text);
}
{
  const text = whyText(legDoc(ranked(NONE)));
  check("why: no record at all says so, sample 0", text.includes("No record yet - ranked last") && text.includes("Sample: 0 graded picks"), text);
}

// ---- 2. Locked ----------------------------------------------------------------
{
  const doc = legDoc(ranked(LEAGUE), { locked: true });
  check("locked: a locked leg's why says Locked", tagsOf(doc).includes("Locked"), JSON.stringify(tagsOf(doc)));
}

// ---- 3. An alternate's game rank --------------------------------------------
{
  const doc = legDoc(ranked(LEAGUE), { gameRank: 2 });
  check("rank: an alternate's #2 pick says so", tagsOf(doc).includes("Game's #2 pick"), JSON.stringify(tagsOf(doc)));
  const top = legDoc(ranked(LEAGUE), { gameRank: 1 });
  check("rank: a game's #1 pick has no rank tag", tagsOf(top).length === 0, JSON.stringify(tagsOf(top)));
}
// The real alternates: one game, three picks ranked league > overall > last20.
// Draw until every one of them has been an alternate's leg; each must carry
// its real place in the game (none for #1).
{
  const game = (n: number, picks: GeneratorPick[]): GeneratorGame => ({
    gameId: "g" + n, gameLabel: "A" + n + " @ H" + n, gameTime: FUTURE, leagueName: "NFL",
    picks: picks.map((p) => ({ ...p, gameId: "g" + n, gameLabel: "A" + n + " @ H" + n })),
  });
  const games = [game(1, [LAST20, LEAGUE, OVERALL])];
  const order = rankGamePicks(games[0].picks, RECORDS).map((r) => r.pick.pickId);
  const primary: AutoParlay = { requested: 1, available: 1, legs: [] };
  primary.legs = [{ gameId: "g1", gameLabel: "A1 @ H1", gameTime: FUTURE, top: rankGamePicks(games[0].picks, RECORDS)[0], next: [] }];
  const seen = new Map<string, number | undefined>();
  let seed = 1;
  const rng = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 200 && seen.size < 3; i++) {
    const set = buildParlaySet({ games, records: RECORDS, slip: EMPTY_SLIP, primary, includePrimary: false, count: 1, exclude: new Set(), extraLegs: () => [], rng, maxTries: 1 });
    for (const p of set.parlays) for (const l of p.legs) seen.set(l.top.pick.pickId, l.gameRank);
  }
  check("rank: the game ranks league, overall, last20", order.join() === "league,overall,last20", order.join());
  check("rank: an alternate taking the game's #1 carries no rank", seen.has("league") && seen.get("league") === undefined, JSON.stringify([...seen]));
  check("rank: an alternate taking the #2 says 2", seen.get("overall") === 2, JSON.stringify([...seen]));
  check("rank: an alternate taking the #3 says 3", seen.get("last20") === 3, JSON.stringify([...seen]));
}

// ---- 4. Excluded from your slip -------------------------------------------------
{
  const empty = render(createElement(ExcludedFromSlip, { items: [] }));
  check("excluded: nothing rendered when nothing was excluded", empty.body.innerHTML === "", empty.body.innerHTML);

  // Over and Under the same total on one game: the higher-ranked keeps its place.
  const cand = (id: string, detail: string): BuildCandidate => ({
    pickId: id, label: "Capper " + id + " — " + detail, betType: "TOTAL", period: "FULL_GAME", betDetail: detail, line: 44.5,
    homeTeam: "Home1", awayTeam: "Away1", gameTime: new Date(FUTURE), sportName: "NFL", gameId: "g1",
  });
  const built = selectConflictFreeLegs([cand("a", "Over 44.5"), cand("b", "Under 44.5")], 2);
  check("excluded: the fixture really conflicts", built.skipped.length === 1, JSON.stringify(built.skipped));
  const items = [...skippedAsExcluded(built.skipped), { key: "game:g9", label: "Away9 @ Home9", reason: "Game started" }];
  const doc = render(createElement(ExcludedFromSlip, { items }));
  const text = doc.body.textContent ?? "";
  check("excluded: has its heading", text.includes("Excluded from your slip"), text);
  const lis = Array.from(doc.querySelectorAll("li")).map((li) => Array.from(li.querySelectorAll("p")).map((p) => p.textContent));
  check("excluded: the skipped pick, by its label", lis[0]?.[0] === "Capper b — Under 44.5", JSON.stringify(lis));
  check(
    "excluded: ...with the build's own reason (the note's wording, minus its 'Skipped <label> — ')",
    lis[0]?.[1] === "conflicts with Capper a — Over 44.5 (higher-ranked)" && built.skipped[0].note === `Skipped Capper b — Under 44.5 — ${lis[0]?.[1]}`,
    JSON.stringify([lis[0], built.skipped[0]?.note])
  );
  check("excluded: a started slip game says Game started", lis[1]?.[0] === "Away9 @ Home9" && lis[1]?.[1] === "Game started", JSON.stringify(lis));
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
