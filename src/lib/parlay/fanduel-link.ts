// "Send to FanDuel" for a built parlay (/parlay): turns each leg into the one
// FanDuel selection it names and builds the betslip link from the ones found.
// Pure - the Odds API calls and the pick rows come in through FanDuelDeps and
// FanDuelLegInput (server/data/fanduel-link.ts), so everything here runs in a
// test with no network and no DB.
//
// Never a guess at the bet: a leg is sent only when exactly one FanDuel outcome
// is the same market, the same period and the same team / Over / Under /
// player. The line is looked for in this order:
//   1. the pick's own line on the main market
//   2. the pick's own line on FanDuel's alternate-lines market
//   3. the nearest line for the same bet across both, within
//      MAX_LINE_MOVE_POINTS / MAX_PROP_LINE_MOVE_RATIO - sent as "adjusted",
//      with both lines and whether the sent one is harder to win
// Two candidates, a line too far off, or a market FanDuel doesn't sell for the
// league leaves the leg out and says why. The other side of a bet, or another
// market, is never a substitute.
import { extractLine, isAnytimeTdPick, parseAnyPlayerProp, parsePlayerPropLine, totalSideFromText } from "@/lib/bet-line";
import { threeWayWording } from "@/lib/nhl-three-way";
import { derivePickSide } from "@/lib/pick-side";
import { teamNamesMatch } from "@/lib/team-name-match";
import { normalizeName } from "@/lib/fuzzy-match";
import { oddsApiRequestKeys } from "@/lib/sport-seasons";

export type FanDuelLegStatus = "matched" | "adjusted" | "started" | "not_found" | "ambiguous" | "unsupported" | "error";

// The pick's line and the FanDuel line sent in its place. `side` is null for a
// spread, whose lines are signed for the pick's own team. `worse`: the sent
// line is harder to win than the pick's (Over at a higher number, Under at a
// lower one, a spread with fewer points).
export type FanDuelSentLine = { pick: number; fanDuel: number; side: "Over" | "Under" | null; worse: boolean };

export type FanDuelLegResult = {
  pickId: string;
  status: FanDuelLegStatus;
  reason: string | null; // null only for "matched" and "adjusted"
  pickOdds: number | null;
  // FanDuel's current price for the selection actually sent ("matched" and
  // "adjusted" only) - an alternate line's own price, never the main line's.
  fanDuelOdds: number | null;
  sentLine: FanDuelSentLine | null; // "adjusted" only
};

export type FanDuelLinkResponse = { url: string | null; legs: FanDuelLegResult[] };

const NOT_SENT_LABEL: Record<Exclude<FanDuelLegStatus, "matched" | "adjusted">, string> = {
  started: "Started",
  not_found: "Not found",
  ambiguous: "Ambiguous",
  unsupported: "Not supported",
  error: "Unavailable",
};

// The chip and the sentence shown for a leg that wasn't sent. Neither is ever
// empty: a status this build doesn't know (a page left open across a deploy
// that added one) or a leg that came back with no reason still says something.
export function notSentDisplay(leg: { status: string; reason?: string | null }): { label: string; reason: string } {
  const label = (NOT_SENT_LABEL as Record<string, string | undefined>)[leg.status];
  const reason = typeof leg.reason === "string" ? leg.reason.trim() : "";
  if (!label) return { label: "Not sent", reason: reason || "Couldn't read FanDuel's answer for this leg - reload the page and check again." };
  return { label, reason: reason || "FanDuel couldn't take this leg right now - check again." };
}

// One leg as the server read it: the pick row's own bet, under the game the
// Live board shows it on (so gameTime is the real kickoff - see
// parlay-slip-picks.ts). sportKey is the Odds API key, null for a league the
// odds feed doesn't carry.
export type FanDuelLegInput = {
  pickId: string;
  sportKey: string | null;
  leagueName: string;
  betType: string;
  period: string;
  betDetail: string | null;
  line: number | null;
  homeTeam: string;
  awayTeam: string;
  gameTime: string;
  odds: number;
  // False when the board has no game for the pick: its teams and time are the
  // row's own, and that time is the import time when the import matched no game.
  onBoard: boolean;
};

// ---------------------------------------------------------------------
// The betslip link
// ---------------------------------------------------------------------

// Fixed here, never taken from a request or from the feed.
export const FANDUEL_BETSLIP_URL = "https://account.sportsbook.fanduel.com/sportsbook/addToBetslip";

export type FanDuelSelection = { marketId: string; selectionId: string };

// The one place the link's format lives: marketId[n] / selectionId[n], in leg
// order, a single leg as [0]. If FanDuel needs a different encoding, it
// changes here and nowhere else.
export function buildFanDuelBetslipUrl(selections: FanDuelSelection[]): string | null {
  if (selections.length === 0) return null;
  const params = new URLSearchParams();
  selections.forEach((s, i) => {
    params.append(`marketId[${i}]`, s.marketId);
    params.append(`selectionId[${i}]`, s.selectionId);
  });
  return FANDUEL_BETSLIP_URL + "?" + params.toString();
}

// ---------------------------------------------------------------------
// Pick -> the market and outcome it names
// ---------------------------------------------------------------------

// What a leg is looking for in one event's FanDuel markets. `side` is the
// pick's team for h2h/spreads (its name comes from the resolved event, so it
// is spelled the way the feed spells it); `name` is Over / Under / Yes / Draw.
export type FanDuelLegTarget = {
  marketKey: string;
  // FanDuel's alternate-lines market for the same bet. Asked for only when the
  // main market doesn't have the pick's line.
  altMarketKey?: string;
  outcome: { side: "HOME" | "AWAY" } | { name: "Over" | "Under" | "Yes" | "Draw" };
  player?: string;
  // A team total: whose. The feed puts the team where a prop has its player.
  team?: "HOME" | "AWAY";
  point?: number;
  // How far FanDuel's line may sit from the point and still be sent in its
  // place. Absent: the line has to be the pick's own.
  maxLineMove?: number;
  // Which way a line gets easier to win: lower for an Over, higher for an
  // Under or a spread. Breaks a tie between two equally near lines, and says
  // whether an adjusted line is a worse one.
  easier?: "lower" | "higher";
};

// A spread, total or team total goes at FanDuel's line when it is within this
// many points of the pick's; a yardage or receptions prop when within this
// share of the pick's line.
export const MAX_LINE_MOVE_POINTS = 1.5;
export const MAX_PROP_LINE_MOVE_RATIO = 0.1;

const FOOTBALL_SPORT_KEYS = new Set(["americanfootball_nfl", "americanfootball_ncaaf"]);
const NHL_SPORT_KEY = "icehockey_nhl";

// Over/Under player props, by the market parseAnyPlayerProp names. Only keys
// this app has already fetched from the Odds API (NFL_PROP_MARKET_KEYS in
// nfl-prop-odds.ts) - an unknown key fails the whole event request, so an
// unconfirmed one is left unsupported rather than tried.
const FOOTBALL_LINE_PROP_KEYS: Record<string, string> = {
  PASS_YDS: "player_pass_yds",
  RUSH_YDS: "player_rush_yds",
  REC_YDS: "player_reception_yds",
  RECEPTIONS: "player_receptions",
  RUSH_REC_YDS: "player_rush_reception_yds",
  PASS_RUSH_YDS: "player_pass_rush_yds",
  PASS_TDS: "player_pass_tds",
};
// Passing touchdowns is neither yardage nor receptions: exact line only.
const EXACT_LINE_PROP_KEYS = new Set(["player_pass_tds"]);
const ANYTIME_TD_KEY = "player_anytime_td";
const ANYTIME_GOAL_KEY = "player_goal_scorer_anytime";
const HOCKEY_THREE_WAY_KEY = "h2h_3_way";

// The game markets FanDuel sells for one period of one league: the suffix the
// Odds API puts on h2h / spreads / totals, which of them also have an
// alternate-lines market, and whether there is a team total. A period missing
// from a league's table isn't sold there (NCAAF has no second half).
//
// Each row is what a live FanDuel-only event call returned on 2026-10-13
// (captures in __fixtures__/), not what the Odds API documents. The exception
// is NBA: only a preseason game was on the board and it carried the three
// main markets alone, so NBA is wired like the NFL and unverified until a
// regular-season response can be captured (first games 2026-10-20). A market
// asked for and not offered costs nothing and comes back as "not found".
type LineMarket = "spreads" | "totals" | "team_totals";
type PeriodMarkets = { suffix: string; alternates: readonly LineMarket[]; teamTotals: boolean };
const ALL_LINES: readonly LineMarket[] = ["spreads", "totals", "team_totals"];
const mainOnly = (suffix: string): PeriodMarkets => ({ suffix, alternates: [], teamTotals: false });
const QUARTERS = {
  FIRST_QUARTER: mainOnly("_q1"),
  SECOND_QUARTER: mainOnly("_q2"),
  THIRD_QUARTER: mainOnly("_q3"),
  FOURTH_QUARTER: mainOnly("_q4"),
};
const NFL_MARKETS: Record<string, PeriodMarkets> = {
  FULL_GAME: { suffix: "", alternates: ALL_LINES, teamTotals: true },
  FIRST_HALF: { suffix: "_h1", alternates: ALL_LINES, teamTotals: true },
  SECOND_HALF: mainOnly("_h2"),
  ...QUARTERS,
};
const PERIOD_MARKETS: Record<string, Record<string, PeriodMarkets>> = {
  americanfootball_nfl: NFL_MARKETS,
  americanfootball_ncaaf: {
    FULL_GAME: { suffix: "", alternates: ALL_LINES, teamTotals: true },
    FIRST_HALF: { suffix: "_h1", alternates: [], teamTotals: true },
    ...QUARTERS,
  },
  icehockey_nhl: {
    FULL_GAME: { suffix: "", alternates: ALL_LINES, teamTotals: true },
    FIRST_PERIOD: { suffix: "_p1", alternates: ["spreads", "totals"], teamTotals: true },
    SECOND_PERIOD: mainOnly("_p2"),
    THIRD_PERIOD: mainOnly("_p3"),
  },
  baseball_mlb: {
    FULL_GAME: { suffix: "", alternates: ["spreads", "totals"], teamTotals: true },
    FIRST_HALF: { suffix: "_1st_5_innings", alternates: ["spreads", "totals"], teamTotals: false },
  },
  basketball_nba: NFL_MARKETS,
};
// Every other league the feed carries: the full game, with the alternate
// spreads and totals the import already buys (ALT_LINE_MARKET_KEYS).
const OTHER_LEAGUE_MARKETS: Record<string, PeriodMarkets> = {
  FULL_GAME: { suffix: "", alternates: ["spreads", "totals"], teamTotals: false },
};

type TargetResult = { ok: true; target: FanDuelLegTarget } | { ok: false; reason: string };
const unsupported = (reason: string): TargetResult => ({ ok: false, reason });

function playerPropTarget(leg: FanDuelLegInput): TargetResult {
  const text = leg.betDetail ?? "";
  const prop = parseAnyPlayerProp(text);
  if (!prop) return unsupported("Couldn't read this player prop.");

  if (prop.propMarket === "TD") {
    if (!FOOTBALL_SPORT_KEYS.has(leg.sportKey ?? "") || !isAnytimeTdPick(text)) {
      return unsupported("Only anytime-touchdown scorer props can be sent.");
    }
    return { ok: true, target: { marketKey: ANYTIME_TD_KEY, outcome: { name: "Yes" }, player: prop.playerName } };
  }
  if (prop.propMarket === "ANYTIME_GOAL" && leg.sportKey === NHL_SPORT_KEY) {
    return { ok: true, target: { marketKey: ANYTIME_GOAL_KEY, outcome: { name: "Yes" }, player: prop.playerName } };
  }

  const marketKey = FOOTBALL_SPORT_KEYS.has(leg.sportKey ?? "") ? FOOTBALL_LINE_PROP_KEYS[prop.propMarket] : undefined;
  if (!marketKey) return unsupported("This player prop market can't be sent yet.");
  const lineInfo = parsePlayerPropLine(text);
  if (!lineInfo) return unsupported("This prop has no Over/Under line to match.");
  const over = lineInfo.direction === "OVER";
  return {
    ok: true,
    target: {
      marketKey,
      outcome: { name: over ? "Over" : "Under" },
      player: prop.playerName,
      point: lineInfo.line,
      ...(EXACT_LINE_PROP_KEYS.has(marketKey) ? {} : { maxLineMove: Math.abs(lineInfo.line) * MAX_PROP_LINE_MOVE_RATIO, easier: over ? "lower" : "higher" }),
    },
  };
}

// A spread / total / team total: its main market for the period, the
// alternate-lines market when FanDuel has one there, and the line rules.
function lineTarget(
  market: LineMarket,
  period: PeriodMarkets,
  rest: Pick<FanDuelLegTarget, "outcome" | "team"> & { point: number; easier: "lower" | "higher" }
): TargetResult {
  return {
    ok: true,
    target: {
      marketKey: market + period.suffix,
      ...(period.alternates.includes(market) ? { altMarketKey: "alternate_" + market + period.suffix } : {}),
      ...rest,
      maxLineMove: MAX_LINE_MOVE_POINTS,
    },
  };
}

// The market and outcome a leg names, or why it can't be sent. Moneyline /
// spread / total / team total in every period FanDuel sells for the league
// (PERIOD_MARKETS), the hockey 3-way moneyline, plus the player props above.
export function fanDuelLegTarget(leg: FanDuelLegInput): TargetResult {
  if (!leg.sportKey) return unsupported(leg.leagueName + " isn't available to send.");

  if (leg.betType === "PLAYER_PROP") {
    if (leg.period !== "FULL_GAME") return unsupported("Only full-game player props can be sent.");
    return playerPropTarget(leg);
  }

  // Team totals have no side of their own (derivePickSide answers only for a
  // moneyline or spread), so the team is read the way a moneyline's is.
  const teamOf = (betType: string) => derivePickSide({ betType, betDetail: leg.betDetail }, leg, leg.leagueName);

  if (leg.period === "REGULATION") {
    if (leg.sportKey !== NHL_SPORT_KEY || leg.betType !== "MONEYLINE") return unsupported("This bet type can't be sent yet.");
    if (threeWayWording(leg.betDetail) === "DRAW") return { ok: true, target: { marketKey: HOCKEY_THREE_WAY_KEY, outcome: { name: "Draw" } } };
    const side = teamOf("MONEYLINE");
    if (!side) return unsupported("Couldn't tell which team this pick is on.");
    return { ok: true, target: { marketKey: HOCKEY_THREE_WAY_KEY, outcome: { side } } };
  }

  const period = (PERIOD_MARKETS[leg.sportKey] ?? OTHER_LEAGUE_MARKETS)[leg.period];
  if (!period) return unsupported("FanDuel doesn't offer this period for " + leg.leagueName + ".");

  if (leg.betType === "MONEYLINE" || leg.betType === "SPREAD") {
    const side = teamOf(leg.betType);
    if (!side) return unsupported("Couldn't tell which team this pick is on.");
    if (leg.betType === "MONEYLINE") return { ok: true, target: { marketKey: "h2h" + period.suffix, outcome: { side } } };
    const point = leg.line ?? extractLine("SPREAD", leg.betDetail ?? "");
    if (point === null) return unsupported("This spread has no line to match.");
    return lineTarget("spreads", period, { outcome: { side }, point, easier: "higher" });
  }

  if (leg.betType === "TOTAL" || leg.betType === "TEAM_TOTAL") {
    const teamTotal = leg.betType === "TEAM_TOTAL";
    if (teamTotal && !period.teamTotals) return unsupported("FanDuel doesn't offer this team total for " + leg.leagueName + ".");
    const team = teamTotal ? teamOf("MONEYLINE") : null;
    if (teamTotal && !team) return unsupported("Couldn't tell which team this total is for.");
    const side = totalSideFromText(leg.betDetail);
    if (!side) return unsupported("Couldn't tell if this total is Over or Under.");
    const point = leg.line ?? extractLine(leg.betType, leg.betDetail ?? "");
    if (point === null) return unsupported("This total has no line to match.");
    const over = side === "OVER";
    return lineTarget(teamTotal ? "team_totals" : "totals", period, {
      outcome: { name: over ? "Over" : "Under" },
      ...(team ? { team } : {}),
      point,
      easier: over ? "lower" : "higher",
    });
  }

  return unsupported("This bet type can't be sent yet.");
}

// ---------------------------------------------------------------------
// The outcome matcher
// ---------------------------------------------------------------------

// The Odds API's FanDuel bookmaker, as returned with includeSids/includeLinks.
// The outcome's sid is FanDuel's selectionId. The market's own sid comes back
// null (verified live 2026-10-12), so the marketId is read from the outcome's
// betslip link, which carries both.
export type FanDuelOutcome = {
  name: string;
  description?: string;
  price: number;
  point?: number;
  sid?: string | null;
  link?: string | null;
};
export type FanDuelMarket = { key: string; sid?: string | null; outcomes: FanDuelOutcome[] };

const MARKET_ID = /^\d+(\.\d+)?$/;
const SELECTION_ID = /^\d+$/;

// The ids in an outcome's own betslip link - only from a fanduel.com
// addToBetslip link, and only as ids (never the link itself).
function idsFromLink(link: string | null | undefined): Partial<FanDuelSelection> {
  if (!link) return {};
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return {};
  }
  const onFanDuel = url.protocol === "https:" && (url.hostname === "fanduel.com" || url.hostname.endsWith(".fanduel.com"));
  if (!onFanDuel || !/\/addToBetslip$/i.test(url.pathname)) return {};
  return { marketId: url.searchParams.get("marketId") ?? undefined, selectionId: url.searchParams.get("selectionId") ?? undefined };
}

// null when the feed gave no usable ids for this outcome, or gave two that
// disagree (its sid and its link's selectionId).
function selectionOf(market: FanDuelMarket, outcome: FanDuelOutcome): FanDuelSelection | null {
  const fromLink = idsFromLink(outcome.link);
  if (outcome.sid && fromLink.selectionId && outcome.sid !== fromLink.selectionId) return null;
  const marketId = market.sid ?? fromLink.marketId;
  const selectionId = outcome.sid ?? fromLink.selectionId;
  if (!marketId || !selectionId || !MARKET_ID.test(marketId) || !SELECTION_ID.test(selectionId)) return null;
  return { marketId, selectionId };
}

// marketKeys in preference order: the main market, then its alternate-lines
// market. `description` is what the feed puts beside the outcome's name - a
// prop's player, a team total's team.
export type FanDuelMatchQuery = {
  marketKeys: string[];
  outcomeName: string;
  description?: string;
  point?: number;
  maxLineMove?: number;
  easier?: "lower" | "higher";
};

export type FanDuelMatch =
  | { status: "matched"; selection: FanDuelSelection; price: number }
  | { status: "adjusted"; selection: FanDuelSelection; price: number; fanDuelLine: number; worse: boolean }
  | { status: "not_found" | "ambiguous"; reason: string };

const AMBIGUOUS = "More than one FanDuel selection fits this pick.";

// Exactly one outcome, or none: the market, the outcome's name and the player
// or team (case and punctuation aside - never a near-miss) all have to be the
// pick's own, so the other side of a bet is never looked at. So does the line,
// unless the query allows a move (maxLineMove) and none of the markets has the
// pick's line: then the nearest line within that move is the match, as
// "adjusted". Two lines equally near (a pick at 6 between 5.5 and 6.5) go to
// the easier one - `easier` - and with no `easier` to nothing.
//
// An alternate-lines market repeats the main line under ids and a price of its
// own (verified live 2026-10-13), so at any one line the selection comes from
// the first of marketKeys that has it.
export function matchFanDuelOutcome(query: FanDuelMatchQuery, markets: FanDuelMarket[]): FanDuelMatch {
  if (!markets.some((m) => query.marketKeys.includes(m.key))) {
    const teamTotal = query.marketKeys[0].startsWith("team_totals");
    return { status: "not_found", reason: teamTotal ? "FanDuel isn't offering a team total for this game." : "FanDuel isn't offering this market right now." };
  }

  const description = query.description === undefined ? null : normalizeName(query.description);
  type Found = { selection: FanDuelSelection; price: number };
  // By line (null for a bet with no line), from the best-ranked market there.
  const byLine = new Map<number | null, { rank: number; found: Map<string, Found> }>();
  let withoutIds = 0;
  query.marketKeys.forEach((key, rank) => {
    for (const market of markets) {
      if (market.key !== key) continue;
      for (const outcome of market.outcomes) {
        if (outcome.name !== query.outcomeName) continue;
        if (description !== null && normalizeName(outcome.description ?? "") !== description) continue;
        if (query.point !== undefined && typeof outcome.point !== "number") continue;
        const line = query.point === undefined ? null : outcome.point!;
        const selection = selectionOf(market, outcome);
        if (!selection) {
          if (line === (query.point ?? null)) withoutIds++;
          continue;
        }
        let at = byLine.get(line);
        if (at && at.rank < rank) continue;
        if (!at) byLine.set(line, (at = { rank, found: new Map() }));
        at.found.set(selection.marketId + "|" + selection.selectionId, { selection, price: outcome.price });
      }
    }
  });

  const exact = Array.from(byLine.get(query.point ?? null)?.found.values() ?? []);
  if (exact.length > 1) return { status: "ambiguous", reason: AMBIGUOUS };
  if (exact.length === 1) return { status: "matched", ...exact[0] };
  if (withoutIds > 0) return { status: "not_found", reason: "FanDuel has this bet, but no betslip link for it." };
  if (query.point === undefined) return { status: "not_found", reason: "FanDuel isn't offering this selection right now." };
  if (query.maxLineMove === undefined || byLine.size === 0) {
    return { status: "not_found", reason: "FanDuel isn't offering this exact line right now." };
  }

  const pickLine = query.point;
  const move = (line: number) => Math.abs(line - pickLine);
  const easierFirst = (x: number, y: number) => (query.easier === "lower" ? x - y : y - x);
  const lines = (Array.from(byLine.keys()) as number[]).sort((x, y) => move(x) - move(y) || easierFirst(x, y));
  const nearest = lines[0];
  // 1e-9: 10% of a .5 line is not an exact binary fraction.
  if (move(nearest) > query.maxLineMove + 1e-9) {
    const overUnder = query.outcomeName === "Over" || query.outcomeName === "Under";
    const shown = overUnder ? query.outcomeName + " " + nearest : (query.marketKeys[0].startsWith("spreads") && nearest > 0 ? "+" : "") + nearest;
    const cap = Math.round(query.maxLineMove * 100) / 100;
    return { status: "not_found", reason: "FanDuel's closest line is " + shown + ", more than " + cap + " away from your pick." };
  }
  const atNearest = Array.from(byLine.get(nearest)!.found.values());
  const tied = lines.length > 1 && move(lines[1]) === move(nearest);
  if (atNearest.length > 1 || (tied && !query.easier)) return { status: "ambiguous", reason: AMBIGUOUS };
  const worse = query.easier === "lower" ? nearest > pickLine : nearest < pickLine;
  return { status: "adjusted", ...atNearest[0], fanDuelLine: nearest, worse };
}

// ---------------------------------------------------------------------
// Legs -> link
// ---------------------------------------------------------------------

// sportKey is the Odds API key the event is listed under - the league's own,
// or its preseason key ("basketball_nba_preseason"). The event's markets can
// only be asked for under that same key.
export type FanDuelEvent = { id: string; sportKey: string; homeTeam: string; awayTeam: string; commenceTime: string };

// Both return null when the feed couldn't be read, and both take the Odds API
// key to ask under (an event's own sportKey for its markets). getEvents is the
// free event listing; getEventMarkets is the metered call (one credit per market
// returned): once per event for the main markets its legs need, and once more
// for the alternate-lines markets of just the legs that missed there.
export type FanDuelDeps = {
  now: Date;
  getEvents: (sportKey: string) => Promise<FanDuelEvent[] | null>;
  getEventMarkets: (sportKey: string, eventId: string, marketKeys: string[]) => Promise<FanDuelMarket[] | null>;
};

// How far a leg's kickoff may sit from the feed's own for the same two teams.
// Covers two sources disagreeing by a few minutes; nowhere near the hours
// between the two games of a doubleheader.
export const EVENT_TIME_TOLERANCE_MS = 10 * 60 * 1000;

const FEED_DOWN = "Couldn't reach FanDuel's odds right now - try again.";

export function hasStarted(gameTime: string, now: Date): boolean {
  const start = new Date(gameTime).getTime();
  return !Number.isFinite(start) || start <= now.getTime();
}

type EventMatch = { event: FanDuelEvent } | { status: "not_found" | "ambiguous" | "started"; reason: string };

function eventForLeg(leg: FanDuelLegInput, events: FanDuelEvent[], now: Date): EventMatch {
  const start = new Date(leg.gameTime).getTime();
  const candidates = events.filter(
    (e) =>
      teamNamesMatch(e.homeTeam, leg.homeTeam, leg.sportKey ?? undefined) &&
      teamNamesMatch(e.awayTeam, leg.awayTeam, leg.sportKey ?? undefined) &&
      Math.abs(new Date(e.commenceTime).getTime() - start) <= EVENT_TIME_TOLERANCE_MS
  );
  if (candidates.length === 0) return { status: "not_found", reason: "Couldn't find this game on FanDuel." };
  if (candidates.length > 1) return { status: "ambiguous", reason: "More than one game fits this pick." };
  if (hasStarted(candidates[0].commenceTime, now)) return { status: "started", reason: "Game has already started." };
  return { event: candidates[0] };
}

// One league's events across every Odds API key it is listed under right now,
// each event once (by id; the league's own key first). null when the league's
// own listing couldn't be read; `incomplete` when only a preseason one couldn't.
async function leagueEvents(sportKey: string, deps: FanDuelDeps): Promise<{ events: FanDuelEvent[]; incomplete: boolean } | null> {
  const [own, ...preseason] = await Promise.all(oddsApiRequestKeys(sportKey, deps.now).map((key) => deps.getEvents(key)));
  if (!own) return null;
  const byId = new Map<string, FanDuelEvent>();
  for (const event of [own, ...preseason].flatMap((events) => events ?? [])) {
    if (!byId.has(event.id)) byId.set(event.id, event);
  }
  return { events: Array.from(byId.values()), incomplete: preseason.some((events) => events === null) };
}

export async function buildFanDuelLink(legs: FanDuelLegInput[], deps: FanDuelDeps): Promise<FanDuelLinkResponse> {
  const results = new Map<string, FanDuelLegResult>();
  const settle = (
    leg: FanDuelLegInput,
    status: FanDuelLegStatus,
    reason: string | null,
    fanDuelOdds: number | null = null,
    sentLine: FanDuelSentLine | null = null
  ) => results.set(leg.pickId, { pickId: leg.pickId, status, reason, pickOdds: leg.odds, fanDuelOdds, sentLine });

  // 1. Started games and unsupported markets never reach the feed.
  const pending: { leg: FanDuelLegInput; target: FanDuelLegTarget }[] = [];
  for (const leg of legs) {
    if (hasStarted(leg.gameTime, deps.now)) {
      settle(leg, "started", leg.onBoard ? "Game has already started." : "Game has started or is no longer on the board.");
      continue;
    }
    const target = fanDuelLegTarget(leg);
    if (!target.ok) {
      settle(leg, "unsupported", target.reason);
      continue;
    }
    pending.push({ leg, target: target.target });
  }

  // 2. Each leg's event, from one listing per league - plus the league's
  // preseason listing while oddsApiRequestKeys says there is one, the same
  // keys the board's own odds are read from (fetchMergedOddsListing).
  const sportKeys = Array.from(new Set(pending.map((p) => p.leg.sportKey!)));
  const listings = new Map(await Promise.all(sportKeys.map(async (key) => [key, await leagueEvents(key, deps)] as const)));
  type Wanted = { leg: FanDuelLegInput; target: FanDuelLegTarget; event: FanDuelEvent };
  const byEvent = new Map<string, Wanted[]>();
  for (const { leg, target } of pending) {
    const listing = listings.get(leg.sportKey!);
    if (!listing) {
      settle(leg, "error", FEED_DOWN);
      continue;
    }
    const match = eventForLeg(leg, listing.events, deps.now);
    if (!("event" in match)) {
      // Not in the listings that were read is not "not on FanDuel" while the
      // preseason listing is unread.
      if (match.status === "not_found" && listing.incomplete) settle(leg, "error", FEED_DOWN);
      else settle(leg, match.status, match.reason);
      continue;
    }
    const key = leg.sportKey + "|" + match.event.id;
    byEvent.set(key, [...(byEvent.get(key) ?? []), { leg, target, event: match.event }]);
  }

  // 3. Per event: the main markets its legs need, then the alternate-lines
  // markets of only the legs whose line the main market didn't have.
  const selections = new Map<string, FanDuelSelection>();
  const finish = ({ leg, target }: Wanted, match: FanDuelMatch) => {
    if (match.status === "matched") {
      selections.set(leg.pickId, match.selection);
      settle(leg, "matched", null, match.price);
    } else if (match.status === "adjusted") {
      selections.set(leg.pickId, match.selection);
      const side = "name" in target.outcome && (target.outcome.name === "Over" || target.outcome.name === "Under") ? target.outcome.name : null;
      settle(leg, "adjusted", null, match.price, { pick: target.point!, fanDuel: match.fanDuelLine, side, worse: match.worse });
    } else {
      settle(leg, match.status, match.reason);
    }
  };
  await Promise.all(
    Array.from(byEvent.values()).map(async (wanted) => {
      const { event } = wanted[0];
      const sportKey = event.sportKey;
      const teamName = (side: "HOME" | "AWAY") => (side === "HOME" ? event.homeTeam : event.awayTeam);
      const query = ({ target }: Wanted, marketKeys: string[], nearest: boolean): FanDuelMatchQuery => ({
        marketKeys,
        outcomeName: "side" in target.outcome ? teamName(target.outcome.side) : target.outcome.name,
        description: target.team ? teamName(target.team) : target.player,
        point: target.point,
        ...(nearest ? { maxLineMove: target.maxLineMove, easier: target.easier } : {}),
      });

      const mainKeys = Array.from(new Set(wanted.map((w) => w.target.marketKey))).sort();
      const main = await deps.getEventMarkets(sportKey, event.id, mainKeys);
      const missed: Wanted[] = [];
      for (const w of wanted) {
        if (!main) {
          settle(w.leg, "error", FEED_DOWN);
          continue;
        }
        // With an alternate market still to ask, only the pick's own line
        // counts here: the nearest line is chosen once every line is in hand.
        const alt = w.target.altMarketKey !== undefined && w.target.point !== undefined;
        const match = matchFanDuelOutcome(query(w, [w.target.marketKey], !alt), main);
        if (alt && match.status === "not_found") missed.push(w);
        else finish(w, match);
      }
      if (!main || missed.length === 0) return;

      const altKeys = Array.from(new Set(missed.map((w) => w.target.altMarketKey!))).sort();
      const alternates = await deps.getEventMarkets(sportKey, event.id, altKeys);
      for (const w of missed) {
        if (!alternates) settle(w.leg, "error", FEED_DOWN);
        else finish(w, matchFanDuelOutcome(query(w, [w.target.marketKey, w.target.altMarketKey!], true), [...main, ...alternates]));
      }
    })
  );

  // In the order the legs were asked for.
  const ordered = legs.map((l) => results.get(l.pickId)!);
  const sent = legs.map((l) => selections.get(l.pickId)).filter((s): s is FanDuelSelection => s !== undefined);
  return { url: buildFanDuelBetslipUrl(sent), legs: ordered };
}
