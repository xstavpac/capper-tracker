// The Consensus Hybrid view-model (hybrid-view.ts): odds display, the settings
// form, target status, the box in words, per-leg lines, which state the page
// shows, Total Legs (the one source of the leg cap), and the Send to FanDuel outcome (including the
// price-moved diff). Pure - no DB, no network, no clock.
//   npx tsx src/lib/parlay/hybrid-view-acceptance-test.ts
import {
  BOX_LEGS_OPTIONS,
  boxText,
  buildSettings,
  cardTabs,
  combinedPrice,
  consensusLine,
  crossGameText,
  DEFAULT_FORM,
  FAR_TARGET_TEXT,
  formatPrice,
  GENERIC_ERROR,
  hybridFor,
  IN_TARGET_TEXT,
  legViews,
  linkLegs,
  linkView,
  maxLegsFor,
  normalizePriceText,
  oddsAsOfText,
  pageState,
  parsePrice,
  priceMoves,
  reasonLine,
  staleText,
  targetStatus,
  type HybridForm,
  type PageInput,
} from "@/lib/parlay/hybrid-view";
import type { Hybrid, HybridLeg, HybridResult } from "@/lib/parlay/hybrid";
import type { HybridLinkResponse } from "@/lib/parlay/hybrid-link";
import type { HybridEventNote, HybridGenerateResponse } from "@/server/data/hybrid-generate";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const M = "-";
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });

// ---- Fixtures ----

function leg(over: Partial<HybridLeg> = {}): HybridLeg {
  return {
    positionKey: "k",
    eventId: "E1",
    homeTeam: "Detroit Lions",
    awayTeam: "Chicago Bears",
    commenceTime: "2026-10-27T00:20:00.000Z",
    sport: "NFL",
    family: "SIDE",
    direction: "Chicago Bears",
    opposite: false,
    marketKey: "alternate_spreads",
    outcomeName: "Chicago Bears",
    point: 14.5,
    price: -135,
    sid: null,
    link: null,
    label: "Chicago Bears +14.5",
    tonightLine: 3.5,
    edge: 14.5,
    edgeSource: "stored",
    keyNumberPush: null,
    snappedPoint: 14.5,
    edgeReached: true,
    move: { rungs: 0, why: "at its edge" },
    reason: "Chicago Bears +14.5 · tonight +3.5 · their games miss the spread by up to 8",
    isStale: false,
    marketLastUpdate: "2026-10-27T19:12:00.000Z",
    consensus: { supporters: 5, opposers: 1, score: 3, anchorLine: 3.5, anchorIsMoneyline: false, topSupporters: [{ capperName: "A", record: "LEAGUE", recordMarket: "SPREAD", wins: 129, losses: 83, n: 212, winPct: 60.85 }] },
    ...over,
  };
}
const OVER = leg({
  positionKey: "t",
  family: "TOTAL",
  direction: "OVER",
  marketKey: "alternate_totals",
  outcomeName: "Over",
  point: 42.5,
  price: -150,
  label: "Over 42.5",
  reason: "Over 42.5 · tonight 47.5 · their games fall short of the total by up to 5",
  consensus: { supporters: 3, opposers: 0, score: 2, anchorLine: 44.5, anchorIsMoneyline: false, topSupporters: [{ capperName: "B", record: "OVERALL", recordMarket: "TOTAL", wins: 70, losses: 40, n: 110, winPct: 63.6 }] },
});
function hybrid(over: Partial<Hybrid> = {}): Hybrid {
  return {
    structure: "same-game-box",
    legs: [leg(), OVER],
    combinedAmerican: -118,
    combinedDecimal: 1.847,
    impliedProbability: 0.541,
    isEstimate: true,
    inTarget: true,
    boxDescription: "Wins if Chicago Bears lose by 14 or fewer and 43+ total points",
    oddsAsOf: "2026-10-27T19:12:00.000Z",
    anyStale: false,
    consensusScore: 5,
    rungsMoved: 0,
    ...over,
  };
}
const note = (kind: HybridEventNote["kind"], eventId = "E1", gameLabel = "Chicago Bears @ Detroit Lions"): HybridEventNote => ({ eventId, gameLabel, kind, message: "x" });
function response(result: Partial<HybridResult> = {}, notes: HybridEventNote[] = [], candidateEvents = ["E1"]): HybridGenerateResponse {
  return { result: { primary: hybrid(), alternates: [], note: null, delivery: { requestedLegs: 3, deliveredLegs: 2, boxes: 1, qualifyingGames: 1, shortOfGames: false }, ...result }, notes, candidateEvents, eventSportKeys: { E1: "americanfootball_nfl" }, linkable: true, generatedAt: "2026-10-27T19:15:00.000Z" };
}
const SETTINGS = { targetMin: -140, targetMax: -110 };
const page = (over: Partial<PageInput> = {}): PageInput => ({ phase: "done", response: response(), errorMessage: null, settings: SETTINGS, ...over });

// ---- Odds display: negative, positive, even ----

check("negative price", formatPrice(-135), M + "135");
check("positive price", formatPrice(120), "+120");
check("even money +100", formatPrice(100), "+100");
check("even money -100 reads +100", formatPrice(-100), "+100");
check("a combined float rounds", formatPrice(-117.6), M + "118");
check("thousands separate", formatPrice(1234), "+1,234");
check("not a price", formatPrice(50), "—");
check("NaN is not a price", formatPrice(Number.NaN), "—");
check("parse negative", parsePrice("-140"), -140);
check("parse unicode minus", parsePrice(M + "140"), -140);
check("parse positive with sign", parsePrice("+120"), 120);
check("parse positive without sign", parsePrice("120"), 120);
check("parse rejects 50", parsePrice("50"), null);
check("parse rejects words", parsePrice("even"), null);
check("parse rejects empty", parsePrice(""), null);
check("normalize signs a bare positive", normalizePriceText("120"), "+120");
check("normalize leaves junk alone", normalizePriceText("abc"), "abc");
check("combined estimate", combinedPrice(hybrid()), { text: "≈ " + M + "118", note: "FanDuel shows final price" });
check("combined exact (cross-game)", combinedPrice(hybrid({ isEstimate: false, combinedAmerican: 263.4 })), { text: "+263", note: null });

// ---- The form -> settings ----

const form = (over: Partial<HybridForm> = {}): HybridForm => ({ ...DEFAULT_FORM, ...over });
check("defaults are -140 / -110, balanced, Total Legs Auto (cap 3), 55%", buildSettings(form()), { ok: true, settings: { targetMin: -140, targetMax: -110, width: "balanced", perLegRange: null, maxLegs: 3, minWinPct: 55, boxLegs: "auto" } });

// ---- Total Legs: 2 · 3 · Auto ----
check("Total Legs options read 2 Legs · 3 Legs · Auto", BOX_LEGS_OPTIONS.map((o) => o.label), ["2 Legs", "3 Legs", "Auto"]);
check("the leg cap comes from Total Legs alone: 2 -> 2, 3 -> 3, Auto -> 3", [maxLegsFor("2"), maxLegsFor("3"), maxLegsFor("auto")], [2, 3, 3]);
const capOf = (over: Partial<HybridForm>) => (buildSettings(form(over)) as { settings: { maxLegs: number; boxLegs: string } }).settings;
check("Total Legs 2 sends 2 legs", [capOf({ boxLegs: "2" }).boxLegs, capOf({ boxLegs: "2" }).maxLegs], ["2", 2]);
check("Total Legs 3 sends 3 legs", [capOf({ boxLegs: "3" }).boxLegs, capOf({ boxLegs: "3" }).maxLegs], ["3", 3]);
check("Total Legs Auto sends 3 legs of room", [capOf({ boxLegs: "auto" }).boxLegs, capOf({ boxLegs: "auto" }).maxLegs], ["auto", 3]);
check("the form no longer carries a Max legs value, so a stale one is ignored", capOf({ boxLegs: "2", ...({ maxLegs: 4 } as object) }).maxLegs, 2);
check("positive targets accepted", buildSettings(form({ targetMin: "+100", targetMax: "+150" })).ok, true);
check("a range across the sign accepted", buildSettings(form({ targetMin: "-110", targetMax: "+120" })).ok, true);
check("min above max is an error on the target field", Object.keys((buildSettings(form({ targetMin: "-110", targetMax: "-140" })) as { errors: object }).errors), ["target"]);
check("min equal to max is fine", buildSettings(form({ targetMin: "-120", targetMax: "-120" })).ok, true);
check("a junk target is an error", Object.keys((buildSettings(form({ targetMax: "abc" })) as { errors: object }).errors), ["target"]);
check("per-leg range ignored while Advanced is closed", (buildSettings(form({ legMin: "-300", legMax: "x" })) as { settings: { perLegRange: unknown } }).settings.perLegRange, null);
check("per-leg range sent when Advanced is open", (buildSettings(form({ advanced: true, legMin: "-300", legMax: "+150" })) as { settings: { perLegRange: unknown } }).settings.perLegRange, { min: -300, max: 150 });
check("advanced open and both empty is no range", (buildSettings(form({ advanced: true })) as { settings: { perLegRange: unknown } }).settings.perLegRange, null);
check("half a per-leg range is an error", Object.keys((buildSettings(form({ advanced: true, legMin: "-300" })) as { errors: object }).errors), ["perLeg"]);
check("backwards per-leg range is an error", Object.keys((buildSettings(form({ advanced: true, legMin: "+150", legMax: "-300" })) as { errors: object }).errors), ["perLeg"]);
check("per-leg range wholly under the -600 floor is an error", Object.keys((buildSettings(form({ advanced: true, legMin: "-900", legMax: "-700" })) as { errors: object }).errors), ["perLeg"]);

// ---- Target status: in, just outside, far outside ----

const RANGE = { targetMin: -140, targetMax: -110 };
check("in range (inside)", targetStatus(-118, RANGE), { kind: "in", text: IN_TARGET_TEXT });
check("in range (on the -140 edge)", targetStatus(-140, RANGE).kind, "in");
check("in range (on the -110 edge)", targetStatus(-110, RANGE).kind, "in");
check("just outside, long side", targetStatus(-143, RANGE), { kind: "near", text: M + "143 · just outside your range" });
check("just outside, short side", targetStatus(-105, RANGE).kind, "near");
check("far outside, long side", targetStatus(-250, RANGE), { kind: "far", text: FAR_TARGET_TEXT });
check("far outside, plus money", targetStatus(250, RANGE), { kind: "far", text: FAR_TARGET_TEXT });
check("positive target range, in", targetStatus(125, { targetMin: 100, targetMax: 150 }).kind, "in");
check("positive target range, just outside", targetStatus(160, { targetMin: 100, targetMax: 150 }).kind, "near");
check("not a price is far", targetStatus(0, RANGE).kind, "far");
check("near wording is not an error wording", /error|fail|invalid/i.test(targetStatus(-143, RANGE).text), false);

// ---- The box in words ----

check("box text as the optimizer wrote it", boxText(hybrid()), "Wins if Chicago Bears lose by 14 or fewer and 43+ total points");
check("box fallback joins two legs", boxText(hybrid({ boxDescription: "" })), "Wins if Chicago Bears +14.5 and Over 42.5");
check("box fallback ignores whitespace", boxText(hybrid({ boxDescription: "   " })), "Wins if Chicago Bears +14.5 and Over 42.5");
check("box fallback with three legs", boxText(hybrid({ boxDescription: "", legs: [leg(), OVER, leg({ label: "Dallas Cowboys -3.5" })] })), "Wins if Chicago Bears +14.5, Over 42.5 and Dallas Cowboys -3.5");

// ---- Leg lines ----

check("consensus line, league record", consensusLine(leg()), "5 cappers · 61% NFL spreads (n=212)");
check("consensus line, overall record", consensusLine(OVER), "3 cappers · 64% all leagues totals (n=110)");
check("consensus line of a 3-leg box's third leg", consensusLine({ ...OVER, direction: "UNDER", opposite: true, consensus: { ...OVER.consensus, supporters: 0, score: 0, topSupporters: [] } }), "Boxes the total from the other side");
check("consensus line with no supporter record", consensusLine(leg({ consensus: { ...leg().consensus, supporters: 1, topSupporters: [] } })), "1 capper");
// The noun is the market of the record used (recordMarket), not the leg's rung.
const withMarket = (recordMarket: "SPREAD" | "MONEYLINE" | "TOTAL", over: Partial<HybridLeg> = {}) =>
  leg({ ...over, consensus: { ...leg().consensus, topSupporters: [{ ...leg().consensus.topSupporters[0], recordMarket }] } });
check("moneyline record on a moneyline leg", consensusLine(withMarket("MONEYLINE", { marketKey: "h2h" })), "5 cappers · 61% NFL moneylines (n=212)");
check("moneyline record on a spread rung still says moneylines", consensusLine(withMarket("MONEYLINE")), "5 cappers · 61% NFL moneylines (n=212)");
check("spread record on a moneyline rung still says spreads", consensusLine(withMarket("SPREAD", { marketKey: "h2h" })), "5 cappers · 61% NFL spreads (n=212)");
check("total record says totals", consensusLine(withMarket("TOTAL", { family: "TOTAL", marketKey: "alternate_totals" })), "5 cappers · 61% NFL totals (n=212)");
check("reason drops the label the row already shows", reasonLine(leg()), "tonight +3.5 · their games miss the spread by up to 8");
check("raw scores stay named", reasonLine(leg({ edgeSource: "raw", reason: "Chicago Bears +14.5 · tonight +3.5 · lost by up to 9 recently · raw scores (lines missing)" })), "tonight +3.5 · lost by up to 9 recently · raw scores (lines missing)");
check("raw scores added when the reason lacks them", reasonLine(leg({ edgeSource: "raw", reason: "Chicago Bears +14.5 · tonight +3.5" })), "tonight +3.5 · raw scores");
check("a stored-edge leg never says raw scores", reasonLine(leg()).includes("raw scores"), false);
check("a one-game box shows no per-leg game", legViews(hybrid()).map((v) => v.game), [null, null]);
check("a cross-game hybrid names each leg's game", legViews(hybrid({ structure: "cross-game", legs: [leg(), leg({ eventId: "E2", awayTeam: "Dallas Cowboys", homeTeam: "New York Giants", positionKey: "z" })] })).map((v) => v.game), ["Chicago Bears @ Detroit Lions", "Dallas Cowboys @ New York Giants"]);
check("leg row: pick and price", (({ title, price }) => ({ title, price }))(legViews(hybrid())[0]), { title: "Chicago Bears +14.5", price: M + "135" });
check("odds as of", oddsAsOfText("2026-10-27T15:12:00.000Z", clock), "Odds as of 3:12 PM");
check("odds as of unknown", oddsAsOfText(null, clock), null);

// ---- The page state, every state ----

check("state: idle", pageState(page({ phase: "idle", response: null })), { kind: "idle" });
check("state: loading", pageState(page({ phase: "loading" })), { kind: "loading" });
check("state: thrown error is friendly", pageState(page({ phase: "error", response: null })), { kind: "error", message: GENERIC_ERROR });
check("state: a rejection keeps its own message", pageState(page({ phase: "error", response: null, errorMessage: "Pick at least one league or game." })), { kind: "error", message: "Pick at least one league or game." });
check("state: done without a response is an error, not a crash", pageState(page({ response: null })).kind, "error");
check(
  "state: in-target result",
  pageState(page()),
  { kind: "result", flags: { outsideTarget: false, crossGame: false, skippedGames: [], pricingGames: [], unavailableGames: [], stale: false } }
);
check(
  "state: no fit",
  pageState(page({ response: response({ primary: hybrid({ inTarget: false, combinedAmerican: -250 }) }) })),
  { kind: "no-fit", flags: { outsideTarget: true, crossGame: false, skippedGames: [], pricingGames: [], unavailableGames: [], stale: false } }
);
check("state: cross-game fallback", (pageState(page({ response: response({ primary: hybrid({ structure: "cross-game", isEstimate: false }) }) })) as { flags: { crossGame: boolean } }).flags.crossGame, true);
check("cross-game wording, two legs", crossGameText(hybrid({ structure: "cross-game" })), "No game has qualifying consensus on both a side and a total. Built from two different games, so the price is exact.");
check("state: skipped games ride along with a result", (pageState(page({ response: response({}, [note("alt-lines-not-posted", "E9", "A @ B")]) })) as { flags: { skippedGames: string[] } }).flags.skippedGames, ["A @ B"]);
check("state: stale primary", (pageState(page({ response: response({ primary: hybrid({ anyStale: true }) }) })) as { flags: { stale: boolean } }).flags.stale, true);
check("state: no primary, alternate lines not posted", pageState(page({ response: response({ primary: null, note: "x" }, [note("alt-lines-not-posted"), note("alt-lines-not-posted", "E2", "C @ D")]) })), { kind: "alt-lines-not-posted", games: ["Chicago Bears @ Detroit Lions", "C @ D"] });
check("state: no primary, another user pricing", pageState(page({ response: response({ primary: null }, [note("pricing-in-progress")]) })), { kind: "pricing-in-progress", games: ["Chicago Bears @ Detroit Lions"] });
check("state: pricing wins over not-posted", pageState(page({ response: response({ primary: null }, [note("alt-lines-not-posted", "E2"), note("pricing-in-progress")]) })).kind, "pricing-in-progress");
check("state: no candidate game at all is the plain no-box message", pageState(page({ response: response({ primary: null, note: "No consensus position has a usable FanDuel ladder." }, [], []) })), { kind: "no-box", message: "No game has qualifying consensus on both a side and a total.", detail: null });
check("state: ladders asked for, none came back, no note: NOT guessed as unavailable", pageState(page({ response: response({ primary: null, note: "No consensus position has a usable FanDuel ladder." }) })).kind, "no-box");
for (const cause of ["budget", "usage-gate", "api-failure", "no-api-key", "lookup-failed"] as const) {
  check("state: ladders-unavailable note (" + cause + ") is the unavailable state", pageState(page({ response: response({ primary: null, note: "x" }, [{ ...note("ladders-unavailable"), cause }]) })), { kind: "prices-unavailable", games: ["Chicago Bears @ Detroit Lions"] });
}
check("state: pricing wins over unavailable, unavailable over not-posted", [pageState(page({ response: response({ primary: null }, [note("ladders-unavailable", "E2"), note("pricing-in-progress")]) })).kind, pageState(page({ response: response({ primary: null }, [note("alt-lines-not-posted", "E2"), note("ladders-unavailable")]) })).kind], ["pricing-in-progress", "prices-unavailable"]);
check("state: unavailable games ride along with a result", (pageState(page({ response: response({}, [note("ladders-unavailable", "E9", "A @ B")]) })) as { flags: { unavailableGames: string[] } }).flags.unavailableGames, ["A @ B"]);
check("state: only one placeable game", pageState(page({ response: response({ primary: null, note: "Only one game has a placeable consensus position." }) })), { kind: "no-box", message: "No game has qualifying consensus on both a side and a total.", detail: "Only one game has a placeable consensus position." });

// ---- Alternates ----

const withAlts = response({ alternates: [hybrid({ combinedAmerican: -125 }), hybrid({ combinedAmerican: -130 })] });
check("tabs: primary + 2 alternates", cardTabs(withAlts).map((t) => t.label), ["Primary", "Alt 1", "Alt 2"]);
check("tabs: primary only", cardTabs(response()).map((t) => t.label), ["Primary"]);
check("tabs: none without a primary", cardTabs(response({ primary: null })), []);
check("alt 2 is the second alternate", hybridFor(withAlts, "alt-2")?.combinedAmerican, -130);
check("a missing alternate is null", hybridFor(response(), "alt-1"), null);

// ---- Send to FanDuel ----

check("link legs carry the exact line and the event's sport key", linkLegs(hybrid(), { E1: "americanfootball_nfl" }), [
  { eventId: "E1", sportKey: "americanfootball_nfl", marketKey: "alternate_spreads", outcomeName: "Chicago Bears", point: 14.5 },
  { eventId: "E1", sportKey: "americanfootball_nfl", marketKey: "alternate_totals", outcomeName: "Over", point: 42.5 },
]);
check("no sport key, nothing to send", linkLegs(hybrid(), {}), null);

const L0 = linkLegs(hybrid(), { E1: "americanfootball_nfl" })!;
const matched = (i: number, price: number) => ({ status: "matched" as const, leg: L0[i], price, isStale: false });
const link = (over: Partial<HybridLinkResponse> & Pick<HybridLinkResponse, "legs">): HybridLinkResponse => ({ url: "https://sportsbook.fanduel.com/addToBetslip?x=1", anyStale: false, oddsAsOf: "2026-10-27T19:12:00.000Z", ...over });

check("price unchanged: no moves, no re-price", priceMoves(hybrid(), link({ legs: [matched(0, -135), matched(1, -150)] })), { moves: [], combined: null });
const moved = priceMoves(hybrid(), link({ legs: [matched(0, -135), matched(1, -165)] }));
check("price moved: the change reads from -> to", moved.moves.map((m) => m.text), ["Over 42.5 moved " + M + "150 → " + M + "165"]);
check("price moved: the combined estimate is re-priced", moved.combined && { american: Math.round(moved.combined.american), text: moved.combined.text }, { american: 180, text: "≈ +180" });
const readyView = linkView(hybrid(), link({ legs: [matched(0, -135), matched(1, -165)] }), RANGE, clock);
check("ready view: the new estimate is judged against the target (far)", readyView.kind === "ready" && readyView.combined?.status.kind, "far");
// -250 and -470 re-priced together: about -143, just outside -140 / -110.
const shortLegs = hybrid({ legs: [leg({ price: -240 }), { ...OVER, price: -470 }] });
const nearView = linkView(shortLegs, link({ legs: [matched(0, -250), matched(1, -470)] }), RANGE, clock);
check("ready view: a re-price just outside the target", nearView.kind === "ready" && nearView.combined && { text: nearView.combined.text, kind: nearView.combined.status.kind }, { text: "≈ " + M + "143", kind: "near" });
// A 3-leg box re-prices as side x (pOver + pUnder - 1). Over 225.5 -275 + Under 248.5 -320 with a
// -135 side: 0.5745 x 0.4952 = 0.2845 -> +251 (the plain product would be about +68).
{
  const OVER2 = { ...OVER, point: 225.5, price: -275, label: "Over 225.5" };
  const UNDER2 = { ...OVER, direction: "UNDER", outcomeName: "Under", point: 248.5, price: -300, label: "Under 248.5", opposite: true };
  const box3 = hybrid({ legs: [leg(), OVER2, UNDER2] });
  const L3 = linkLegs(box3, { E1: "americanfootball_nfl" })!;
  const m3 = (i: number, price: number) => ({ status: "matched" as const, leg: L3[i], price, isStale: false });
  const re = priceMoves(box3, link({ legs: [m3(0, -135), m3(1, -275), m3(2, -320)] }));
  check("3-leg re-price: the Under's move reads from -> to", re.moves.map((m) => m.text), ["Under 248.5 moved " + M + "300 → " + M + "320"]);
  check("3-leg re-price: side x corridor, about +251", re.combined && { american: Math.round(re.combined.american), text: re.combined.text }, { american: 251, text: "≈ +251" });
}
check("ready view: no move, no combined", linkView(hybrid(), link({ legs: [matched(0, -135), matched(1, -150)] }), RANGE, clock).kind === "ready" && (linkView(hybrid(), link({ legs: [matched(0, -135), matched(1, -150)] }), RANGE, clock) as { combined: unknown }).combined, null);

const goneSpread = { status: "gone" as const, leg: L0[0], reason: "FanDuel no longer has this exact line (closest is 13.5).", nearest: { point: 13.5, price: -155 } };
check("no link: a line is gone, with the nearest", linkView(hybrid(), link({ url: null, legs: [goneSpread, matched(1, -150)] }), RANGE, clock), {
  kind: "blocked",
  lines: ["Chicago Bears +14.5 is no longer posted. Nearest is +13.5 at " + M + "155."],
  stale: false,
});
const goneTotal = { status: "gone" as const, leg: L0[1], reason: "x", nearest: { point: 41.5, price: -170 } };
check("no link: a total's nearest line is the bare number", (linkView(hybrid(), link({ url: null, legs: [matched(0, -135), goneTotal] }), RANGE, clock) as { lines: string[] }).lines, ["Over 42.5 is no longer posted. Nearest is 41.5 at " + M + "170."]);
const goneNoNearest = { status: "gone" as const, leg: L0[1], reason: "This game has started.", nearest: null };
check("no link: a gone leg with no nearest keeps the action's reason", (linkView(hybrid(), link({ url: null, legs: [matched(0, -135), goneNoNearest] }), RANGE, clock) as { lines: string[] }).lines, ["Over 42.5: This game has started."]);
const staleGone = { status: "gone" as const, leg: L0[0], reason: "FanDuel's odds couldn't be refreshed - try again.", nearest: null, stale: { asOf: "2026-10-27T15:12:00.000Z" } };
check("no link: stale after the re-price names the time, from the structured staleAsOf", linkView(hybrid(), link({ url: null, anyStale: true, staleAsOf: "2026-10-27T15:12:00.000Z", legs: [staleGone, matched(1, -150)] }), RANGE, clock), {
  kind: "blocked",
  lines: ["FanDuel's odds couldn't be refreshed (as of 3:12 PM) - try again."],
  stale: true,
});
check("stale text with a time", staleText("2026-10-27T15:12:00.000Z", clock), "FanDuel's odds couldn't be refreshed (as of 3:12 PM) - try again.");
check("stale text without a time", staleText(null, clock), "FanDuel's odds couldn't be refreshed - try again.");
check("a stale leg never leaks a raw ISO string", (linkView(hybrid(), link({ url: null, anyStale: true, staleAsOf: "2026-10-27T15:12:00.000Z", legs: [staleGone, matched(1, -150)] }), RANGE, clock) as { lines: string[] }).lines.some((l) => /d{4}-d{2}-d{2}T/.test(l)), false);
check("plain hyphen-minus everywhere: no U+2212 in any price", [formatPrice(-135), targetStatus(-143, RANGE).text, combinedPrice(hybrid()).text, legViews(hybrid())[0].price].some((t) => t.includes("−")), false);

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nAll hybrid view-model checks passed.");
