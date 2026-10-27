// The Consensus Hybrid FanDuel handoff (hybrid-link.ts): each leg goes in the
// betslip at its EXACT point or the whole link is withheld - never the nearest
// line the Standard handoff would substitute. Ids come only from the feed (the
// real captures lib/parlay/__fixtures__/fanduel-event-nba.json and -nfl.json),
// prices come back current, a missing leg is named with FanDuel's nearest point,
// and a request never carries a price, id or link. Pure - no DB, no network.
//   npx tsx src/lib/parlay/hybrid-link-acceptance-test.ts
import nbaEvent from "@/lib/parlay/__fixtures__/fanduel-event-nba.json";
import nflEvent from "@/lib/parlay/__fixtures__/fanduel-event-nfl.json";
import { buildHybridLink, HYBRID_LINK_INVALID, HYBRID_LINK_MAX_LEGS, HYBRID_LINK_TOO_MANY, nearestLine, parseHybridLinkLegs, type HybridLinkLegInput } from "@/lib/parlay/hybrid-link";
import { FANDUEL_BETSLIP_URL } from "@/lib/parlay/fanduel-link";
import type { AltLadder, AltLadderOutcome, AltLadderResult } from "@/server/data/alt-ladders";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

type Ev = { home_team: string; away_team: string; bookmakers: { key: string; markets: { key: string; outcomes: AltLadderOutcome[] }[] }[] };
const FETCHED = new Date("2026-10-26T20:00:00.000Z");
function ladderOf(ev: Ev, key: string, over: { stale?: boolean; edit?: (o: AltLadderOutcome[]) => AltLadderOutcome[] } = {}): AltLadder {
  const m = ev.bookmakers.find((b) => b.key === "fanduel")!.markets.find((x) => x.key === key)!;
  return { outcomes: over.edit ? over.edit(m.outcomes) : m.outcomes, fetchedAt: FETCHED, marketLastUpdate: new Date("2026-10-26T19:55:00.000Z"), isStale: over.stale ?? false };
}
const nba = nbaEvent as unknown as Ev;
const nfl = nflEvent as unknown as Ev;
const NUGGETS = "Denver Nuggets";
const WARRIORS = "Golden State Warriors";

const NBA_LADDERS: AltLadderResult = { NBA1: { alternate_spreads: ladderOf(nba, "alternate_spreads"), alternate_totals: ladderOf(nba, "alternate_totals"), h2h: ladderOf(nba, "h2h") } };
const NFL_LADDERS: AltLadderResult = { NFL1: { alternate_spreads: ladderOf(nfl, "alternate_spreads"), alternate_totals: ladderOf(nfl, "alternate_totals") } };
const outcome = (ev: Ev, key: string, name: string, point?: number) =>
  ev.bookmakers.find((b) => b.key === "fanduel")!.markets.find((m) => m.key === key)!.outcomes.find((o) => o.name === name && (point === undefined || o.point === point))!;

const leg = (eventId: string, marketKey: HybridLinkLegInput["marketKey"], outcomeName: string, point: number | null, sportKey = "basketball_nba"): HybridLinkLegInput => ({ eventId, sportKey, marketKey, outcomeName, point });
const decoded = (url: string | null) => (url === null ? null : decodeURIComponent(url));
const none = () => null;

// ============================================================================
// An exact match builds the link: same-game box = two selections of ONE event
// ============================================================================
{
  const spread = leg("NBA1", "alternate_spreads", NUGGETS, -7.5);
  const total = leg("NBA1", "alternate_totals", "Over", 220.5);
  const r = buildHybridLink([spread, total], NBA_LADDERS, none);
  const sp = outcome(nba, "alternate_spreads", NUGGETS, -7.5);
  const to = outcome(nba, "alternate_totals", "Over", 220.5);
  const mid = (o: AltLadderOutcome) => new URL(o.link!).searchParams.get("marketId")!;
  check("both legs matched, in order", r.legs.map((l) => l.status), ["matched", "matched"]);
  check(
    "the link is the betslip URL with each selection from the feed (marketId + sid)",
    decoded(r.url),
    `${FANDUEL_BETSLIP_URL}?marketId[0]=${mid(sp)}&selectionId[0]=${sp.sid}&marketId[1]=${mid(to)}&selectionId[1]=${to.sid}`
  );
  check("the two legs sit in DIFFERENT markets of one event (market ids differ)", mid(sp) !== mid(to), true);
  check("each leg returns FanDuel's current price", r.legs.map((l) => l.status === "matched" && l.price), [sp.price, to.price]);
  check("fresh ladders: not stale, as-of is the market update", [r.anyStale, r.oddsAsOf], [false, "2026-10-26T19:55:00.000Z"]);
}

// ============================================================================
// 3-leg box: alt spread + alt Over + alt Under on ONE event, each at its exact line
// ============================================================================
{
  const legs = [leg("NBA1", "alternate_spreads", WARRIORS, 19.5), leg("NBA1", "alternate_totals", "Over", 218.5), leg("NBA1", "alternate_totals", "Under", 248.5)];
  const parsed = parseHybridLinkLegs(legs, new Set(["basketball_nba"]));
  check("3-leg box: Over and Under on one game parse (not a duplicate)", Array.isArray(parsed) && parsed.length, 3);
  const r = buildHybridLink(legs, NBA_LADDERS, none);
  const sp = outcome(nba, "alternate_spreads", WARRIORS, 19.5);
  const ov = outcome(nba, "alternate_totals", "Over", 218.5);
  const un = outcome(nba, "alternate_totals", "Under", 248.5);
  const mid = (o: AltLadderOutcome) => new URL(o.link!).searchParams.get("marketId")!;
  check("3-leg box: all three matched", r.legs.map((l) => l.status), ["matched", "matched", "matched"]);
  check(
    "3-leg box: one betslip with all three exact selections",
    decoded(r.url),
    `${FANDUEL_BETSLIP_URL}?marketId[0]=${mid(sp)}&selectionId[0]=${sp.sid}&marketId[1]=${mid(ov)}&selectionId[1]=${ov.sid}&marketId[2]=${mid(un)}&selectionId[2]=${un.sid}`
  );
  check("3-leg box: FanDuel's prices back, exact lines", r.legs.map((l) => l.status === "matched" && [l.leg.point, l.price]), [[19.5, sp.price], [218.5, ov.price], [248.5, un.price]]);
  // A pulled Under withholds the whole slip.
  const pulled: AltLadderResult = { NBA1: { ...NBA_LADDERS.NBA1, alternate_totals: ladderOf(nba, "alternate_totals", { edit: (o) => o.filter((x) => !(x.name === "Under" && x.point === 248.5)) }) } };
  check("3-leg box: a pulled Under -> no url", buildHybridLink(legs, pulled, none).url, null);
}

// ============================================================================
// Exact point or nothing: a moved line builds no link and reports the nearest
// ============================================================================
{
  // FanDuel pulled Nuggets -7.5 (ladder goes -8.5 @ 108, -6.5 @ -124).
  const moved: AltLadderResult = { NBA1: { ...NBA_LADDERS.NBA1, alternate_spreads: ladderOf(nba, "alternate_spreads", { edit: (o) => o.filter((x) => !(x.name === NUGGETS && x.point === -7.5)) }) } };
  const r = buildHybridLink([leg("NBA1", "alternate_spreads", NUGGETS, -7.5), leg("NBA1", "alternate_totals", "Over", 220.5)], moved, none);
  check("a pulled line: NO url (never a partial slip)", r.url, null);
  const gone = r.legs[0];
  check("the gone leg is named", [gone.status, gone.status === "gone" && gone.leg.point], ["gone", -7.5]);
  check("its nearest point and price are FanDuel's now (-6.5 @ -124: the easier of the two equally near)", gone.status === "gone" && gone.nearest, { point: -6.5, price: -124 });
  check("the reason says it is the exact line that is gone", gone.status === "gone" && gone.reason, "FanDuel no longer has this exact line (closest is -6.5).");
  check("the other leg still reports its price (matched)", r.legs[1].status === "matched" && r.legs[1].price, outcome(nba, "alternate_totals", "Over", 220.5).price);

  // No nearest-line substitution: a leg at a point that was never on the ladder.
  const off = buildHybridLink([leg("NBA1", "alternate_totals", "Over", 220)], NBA_LADDERS, none);
  check("a point between rungs (220) is NOT moved to 220.5 / 219.5", [off.url, off.legs[0].status], [null, "gone"]);
  check("...and the nearest it reports is 219.5 / 220.5, the lower (easier for an Over) of the two", off.legs[0].status === "gone" && off.legs[0].nearest?.point, 219.5);

  // An Under: the easier of two equally near is the HIGHER number.
  const under = nearestLine(leg("NBA1", "alternate_totals", "Under", 220), NBA_LADDERS.NBA1.alternate_totals);
  check("Under at 220: equally near 219.5 / 220.5 -> 220.5", under?.point, 220.5);

  // The market itself gone.
  const noMarket = buildHybridLink([leg("NBA1", "alternate_totals", "Over", 220.5)], { NBA1: { alternate_spreads: NBA_LADDERS.NBA1.alternate_spreads } }, none);
  check("no ladder at all for the market: gone, no nearest", [noMarket.url, noMarket.legs[0].status === "gone" && noMarket.legs[0].nearest], [null, null]);
}

// ============================================================================
// Ids only from the feed
// ============================================================================
{
  // The request carries extra fields (a price, a link, ids): none of it reaches the result.
  const raw = [{ ...leg("NBA1", "alternate_spreads", NUGGETS, -7.5), price: -9999, sid: "666", marketId: "9.9", link: "https://evil.example/addToBetslip?marketId=1&selectionId=2", url: "https://evil.example" }];
  const parsed = parseHybridLinkLegs(raw, new Set(["basketball_nba"]));
  check("the parsed leg keeps only event / sport / market / outcome / point", Array.isArray(parsed) && Object.keys(parsed[0]).sort(), ["eventId", "marketKey", "outcomeName", "point", "sportKey"]);
  const r = buildHybridLink(parsed as HybridLinkLegInput[], NBA_LADDERS, none);
  const sp = outcome(nba, "alternate_spreads", NUGGETS, -7.5);
  check("the selection ids are the feed's, not the request's", decoded(r.url)?.includes(`selectionId[0]=${sp.sid}`) && !decoded(r.url)!.includes("666") && !r.url!.includes("evil"), true);
  check("the price is the feed's, not the request's", r.legs[0].status === "matched" && r.legs[0].price, sp.price);

  // An outcome with no sid reads both ids from its own fanduel.com link; one with neither is not sendable.
  const noSid: AltLadderResult = { NBA1: { alternate_spreads: ladderOf(nba, "alternate_spreads", { edit: (o) => o.map((x) => (x.point === -7.5 && x.name === NUGGETS ? { ...x, sid: undefined } : x)) }) } };
  const fromLink = buildHybridLink([leg("NBA1", "alternate_spreads", NUGGETS, -7.5)], noSid, none);
  check("sid missing: the link's own selectionId is used", decoded(fromLink.url)?.includes(`selectionId[0]=${sp.sid}`), true);
  const noIds: AltLadderResult = { NBA1: { alternate_spreads: ladderOf(nba, "alternate_spreads", { edit: (o) => o.map((x) => (x.point === -7.5 && x.name === NUGGETS ? { ...x, sid: undefined, link: undefined } : x)) }) } };
  const bare = buildHybridLink([leg("NBA1", "alternate_spreads", NUGGETS, -7.5)], noIds, none);
  check("no sid and no link in the feed: not sent, never guessed", [bare.url, bare.legs[0].status === "gone" && bare.legs[0].reason], [null, "FanDuel has this bet, but no betslip link for it."]);
  const wrongHost: AltLadderResult = { NBA1: { alternate_spreads: ladderOf(nba, "alternate_spreads", { edit: (o) => o.map((x) => (x.point === -7.5 && x.name === NUGGETS ? { ...x, sid: undefined, link: "https://evil.example/addToBetslip?marketId=42.1&selectionId=7" } : x)) }) } };
  check("a link off fanduel.com yields no ids", buildHybridLink([leg("NBA1", "alternate_spreads", NUGGETS, -7.5)], wrongHost, none).url, null);
}

// ============================================================================
// h2h, stale ladders, a leg the caller marks unavailable
// ============================================================================
{
  const ml = buildHybridLink([leg("NBA1", "h2h", NUGGETS, null), leg("NBA1", "alternate_totals", "Under", 230.5)], NBA_LADDERS, none);
  const m = outcome(nba, "h2h", NUGGETS);
  check("a moneyline leg matches by name alone", [ml.legs[0].status, ml.legs[0].status === "matched" && ml.legs[0].price], ["matched", m.price]);
  check("...and builds a two-selection link", decoded(ml.url)?.includes("marketId[1]="), true);

  const stale: AltLadderResult = { NBA1: { alternate_spreads: ladderOf(nba, "alternate_spreads", { stale: true }) } };
  const s = buildHybridLink([leg("NBA1", "alternate_spreads", NUGGETS, -7.5)], stale, none);
  check("a stale ladder is NOT linked: gone, no url, flagged", [s.legs[0].status, s.url, s.anyStale, s.legs[0].status === "gone" && s.legs[0].reason], ["gone", null, true, "FanDuel's odds couldn't be refreshed - try again."]);
  check("a stale ladder: staleAsOf is the market update, structured", [s.staleAsOf, s.legs[0].status === "gone" && s.legs[0].stale], ["2026-10-26T19:55:00.000Z", { asOf: "2026-10-26T19:55:00.000Z" }]);
  check("fresh ladders: staleAsOf is null", ml.staleAsOf, null);

  const blocked = buildHybridLink([leg("NBA1", "alternate_spreads", NUGGETS, -7.5), leg("NBA1", "alternate_totals", "Over", 220.5)], NBA_LADDERS, (l) => (l.marketKey === "alternate_totals" ? "Pricing in progress - try again in a few seconds." : null));
  check("one leg unavailable: no link, the reason is shown", [blocked.url, blocked.legs[1].status === "gone" && blocked.legs[1].reason], [null, "Pricing in progress - try again in a few seconds."]);
}

// ============================================================================
// A 4-leg cross-game combination
// ============================================================================
{
  const ladders: AltLadderResult = { ...NBA_LADDERS, ...NFL_LADDERS };
  const legs = [
    leg("NBA1", "alternate_spreads", NUGGETS, -7.5),
    leg("NBA1", "alternate_totals", "Over", 220.5),
    leg("NFL1", "alternate_spreads", "Seattle Seahawks", -3.5, "americanfootball_nfl"),
    leg("NFL1", "alternate_totals", "Under", 44.5, "americanfootball_nfl"),
  ];
  const r = buildHybridLink(legs, ladders, none);
  const expected = [outcome(nba, "alternate_spreads", NUGGETS, -7.5), outcome(nba, "alternate_totals", "Over", 220.5), outcome(nfl, "alternate_spreads", "Seattle Seahawks", -3.5), outcome(nfl, "alternate_totals", "Under", 44.5)];
  const url = new URL(r.url!);
  check("four legs matched", r.legs.map((l) => l.status), ["matched", "matched", "matched", "matched"]);
  check("four index pairs, in leg order, ids from each feed", [0, 1, 2, 3].map((i) => [url.searchParams.get(`marketId[${i}]`), url.searchParams.get(`selectionId[${i}]`)]), expected.map((o) => [new URL(o.link!).searchParams.get("marketId"), o.sid]));
  check("exactly eight parameters", Array.from(url.searchParams.keys()).length, 8);
  // One leg gone in the second game withholds the whole link.
  const partial = buildHybridLink([...legs.slice(0, 3), leg("NFL1", "alternate_totals", "Under", 44, "americanfootball_nfl")], ladders, none);
  check("one of four gone: no link at all, three matched and the fourth named", [partial.url, partial.legs.map((l) => l.status)], [null, ["matched", "matched", "matched", "gone"]]);
}

// ============================================================================
// Request validation
// ============================================================================
{
  const ok = new Set(["basketball_nba", "basketball_nba_preseason"]);
  const good = leg("NBA1", "alternate_spreads", NUGGETS, -7.5);
  const rejected = (raw: unknown) => !Array.isArray(parseHybridLinkLegs(raw, ok));
  check("a valid leg parses", Array.isArray(parseHybridLinkLegs([good], ok)), true);
  check("a preseason sport key is allowed when the app carries it", Array.isArray(parseHybridLinkLegs([{ ...good, sportKey: "basketball_nba_preseason" }], ok)), true);
  check("not an array / empty", [rejected(null), rejected([]), rejected({})], [true, true, true]);
  check("more than 4 legs", rejected([good, { ...good, point: -6.5 }, { ...good, point: -5.5 }, { ...good, point: -4.5 }, { ...good, point: -3.5 }]), true);
  const five = parseHybridLinkLegs([good, { ...good, point: -6.5 }, { ...good, point: -5.5 }, { ...good, point: -4.5 }, { ...good, point: -3.5 }], ok);
  check("the link cap stays 4, even though a parlay can have 25 legs", HYBRID_LINK_MAX_LEGS, 4);
  check("more than 4 legs gets its own explanation, not the generic one", [!Array.isArray(five) && five.error === HYBRID_LINK_TOO_MANY, HYBRID_LINK_TOO_MANY.includes("up to 4 legs"), (HYBRID_LINK_TOO_MANY as string) === HYBRID_LINK_INVALID], [true, true, false]);
  check("exactly 4 legs parses", Array.isArray(parseHybridLinkLegs([good, { ...good, point: -6.5 }, { ...good, point: -5.5 }, { ...good, point: -4.5 }], ok)), true);
  check("a sport key the app doesn't carry (it ends up in a URL path)", rejected([{ ...good, sportKey: "../../admin" }]), true);
  check("an unknown market", rejected([{ ...good, marketKey: "player_points" }]), true);
  check("an alternate market with no point", rejected([{ ...good, point: null }]), true);
  check("a non-finite point", rejected([{ ...good, point: Infinity }, { ...good, point: "7" }]), true);
  check("h2h with a point", rejected([leg("NBA1", "h2h", NUGGETS, 1.5)]), true);
  check("an empty outcome name / event id", [rejected([{ ...good, outcomeName: "" }]), rejected([{ ...good, eventId: "" }])], [true, true]);
  check("the same leg twice", rejected([good, { ...good }]), true);
  check("the same market at two points is two legs, not a duplicate", Array.isArray(parseHybridLinkLegs([good, { ...good, point: -6.5 }], ok)), true);
}

console.log(failures > 0 ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures > 0 ? 1 : 0);
