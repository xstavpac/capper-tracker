// "Send to FanDuel" for a built parlay (/parlay): turns each leg into the one
// FanDuel selection it names and builds the betslip link from the ones found.
// Pure - the Odds API calls and the pick rows come in through FanDuelDeps and
// FanDuelLegInput (server/data/fanduel-link.ts), so everything here runs in a
// test with no network and no DB.
//
// Never a guess: a leg is sent only when exactly one FanDuel outcome is the
// same market, the same team / Over / Under / player and the same line. A
// different line, two candidates, or a market this file has no key for leaves
// the leg out and says why.
import { extractLine, isAnytimeTdPick, parseAnyPlayerProp, parsePlayerPropLine, totalSideFromText } from "@/lib/bet-line";
import { derivePickSide } from "@/lib/pick-side";
import { teamNamesMatch } from "@/lib/team-name-match";
import { normalizeName } from "@/lib/fuzzy-match";

export type FanDuelLegStatus = "matched" | "started" | "not_found" | "ambiguous" | "unsupported" | "error";

export type FanDuelLegResult = {
  pickId: string;
  status: FanDuelLegStatus;
  reason: string | null; // null only for "matched"
  pickOdds: number | null;
  fanDuelOdds: number | null; // FanDuel's current price, "matched" only
};

export type FanDuelLinkResponse = { url: string | null; legs: FanDuelLegResult[] };

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
// is spelled the way the feed spells it); `name` is Over / Under / Yes.
export type FanDuelLegTarget = {
  marketKey: string;
  outcome: { side: "HOME" | "AWAY" } | { name: "Over" | "Under" | "Yes" };
  player?: string;
  point?: number;
};

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
const ANYTIME_TD_KEY = "player_anytime_td";
const ANYTIME_GOAL_KEY = "player_goal_scorer_anytime";

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
  return {
    ok: true,
    target: {
      marketKey,
      outcome: { name: lineInfo.direction === "OVER" ? "Over" : "Under" },
      player: prop.playerName,
      point: lineInfo.line,
    },
  };
}

// The market and outcome a leg names, or why it can't be sent. Full-game
// moneyline / spread / total in every league the odds feed carries, plus the
// player props above.
export function fanDuelLegTarget(leg: FanDuelLegInput): TargetResult {
  if (!leg.sportKey) return unsupported(leg.leagueName + " isn't available to send.");
  if (leg.period !== "FULL_GAME") return unsupported("Only full-game bets can be sent.");

  if (leg.betType === "PLAYER_PROP") return playerPropTarget(leg);

  if (leg.betType === "MONEYLINE" || leg.betType === "SPREAD") {
    const side = derivePickSide(leg, leg, leg.leagueName);
    if (!side) return unsupported("Couldn't tell which team this pick is on.");
    if (leg.betType === "MONEYLINE") return { ok: true, target: { marketKey: "h2h", outcome: { side } } };
    const point = leg.line ?? extractLine("SPREAD", leg.betDetail ?? "");
    if (point === null) return unsupported("This spread has no line to match.");
    return { ok: true, target: { marketKey: "spreads", outcome: { side }, point } };
  }

  if (leg.betType === "TOTAL") {
    const side = totalSideFromText(leg.betDetail);
    if (!side) return unsupported("Couldn't tell if this total is Over or Under.");
    const point = leg.line ?? extractLine("TOTAL", leg.betDetail ?? "");
    if (point === null) return unsupported("This total has no line to match.");
    return { ok: true, target: { marketKey: "totals", outcome: { name: side === "OVER" ? "Over" : "Under" }, point } };
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

export type FanDuelMatchQuery = { marketKey: string; outcomeName: string; player?: string; point?: number };

export type FanDuelMatch =
  | { status: "matched"; selection: FanDuelSelection; price: number }
  | { status: "not_found" | "ambiguous"; reason: string };

// Exactly one outcome, or none: the market key, the outcome's name, the
// player (case and punctuation aside - never a near-miss) and the line all
// have to be the pick's own. A pick with a line never matches an outcome at
// another line.
export function matchFanDuelOutcome(query: FanDuelMatchQuery, markets: FanDuelMarket[]): FanDuelMatch {
  const inMarket = markets.filter((m) => m.key === query.marketKey);
  if (inMarket.length === 0) return { status: "not_found", reason: "FanDuel isn't offering this market right now." };

  const player = query.player === undefined ? null : normalizeName(query.player);
  const found = new Map<string, { selection: FanDuelSelection; price: number }>();
  let withoutIds = 0;
  for (const market of inMarket) {
    for (const outcome of market.outcomes) {
      if (outcome.name !== query.outcomeName) continue;
      if (query.point !== undefined && outcome.point !== query.point) continue;
      if (player !== null && normalizeName(outcome.description ?? "") !== player) continue;
      const selection = selectionOf(market, outcome);
      if (!selection) {
        withoutIds++;
        continue;
      }
      found.set(selection.marketId + "|" + selection.selectionId, { selection, price: outcome.price });
    }
  }

  if (found.size > 1) return { status: "ambiguous", reason: "More than one FanDuel selection fits this pick." };
  const only = Array.from(found.values())[0];
  if (only) return { status: "matched", ...only };
  if (withoutIds > 0) return { status: "not_found", reason: "FanDuel has this bet, but no betslip link for it." };
  return {
    status: "not_found",
    reason: query.point === undefined ? "FanDuel isn't offering this selection right now." : "FanDuel isn't offering this exact line right now.",
  };
}

// ---------------------------------------------------------------------
// Legs -> link
// ---------------------------------------------------------------------

export type FanDuelEvent = { id: string; homeTeam: string; awayTeam: string; commenceTime: string };

// Both return null when the feed couldn't be read. getEvents is the free
// event listing; getEventMarkets is the one metered call, asked once per
// event for only the market keys its legs need.
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

export async function buildFanDuelLink(legs: FanDuelLegInput[], deps: FanDuelDeps): Promise<FanDuelLinkResponse> {
  const results = new Map<string, FanDuelLegResult>();
  const settle = (leg: FanDuelLegInput, status: FanDuelLegStatus, reason: string | null, fanDuelOdds: number | null = null) =>
    results.set(leg.pickId, { pickId: leg.pickId, status, reason, pickOdds: leg.odds, fanDuelOdds });

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

  // 2. Each leg's event, from one listing per league.
  const sportKeys = Array.from(new Set(pending.map((p) => p.leg.sportKey!)));
  const listings = new Map(await Promise.all(sportKeys.map(async (key) => [key, await deps.getEvents(key)] as const)));
  type Wanted = { leg: FanDuelLegInput; target: FanDuelLegTarget; event: FanDuelEvent };
  const byEvent = new Map<string, Wanted[]>();
  for (const { leg, target } of pending) {
    const events = listings.get(leg.sportKey!);
    if (!events) {
      settle(leg, "error", FEED_DOWN);
      continue;
    }
    const match = eventForLeg(leg, events, deps.now);
    if (!("event" in match)) {
      settle(leg, match.status, match.reason);
      continue;
    }
    const key = leg.sportKey + "|" + match.event.id;
    byEvent.set(key, [...(byEvent.get(key) ?? []), { leg, target, event: match.event }]);
  }

  // 3. One call per event, for only the markets its legs need.
  const selections = new Map<string, FanDuelSelection>();
  await Promise.all(
    Array.from(byEvent.values()).map(async (wanted) => {
      const { event } = wanted[0];
      const marketKeys = Array.from(new Set(wanted.map((w) => w.target.marketKey))).sort();
      const markets = await deps.getEventMarkets(wanted[0].leg.sportKey!, event.id, marketKeys);
      for (const { leg, target } of wanted) {
        if (!markets) {
          settle(leg, "error", FEED_DOWN);
          continue;
        }
        const outcomeName = "side" in target.outcome ? (target.outcome.side === "HOME" ? event.homeTeam : event.awayTeam) : target.outcome.name;
        const match = matchFanDuelOutcome({ marketKey: target.marketKey, outcomeName, player: target.player, point: target.point }, markets);
        if (match.status === "matched") {
          selections.set(leg.pickId, match.selection);
          settle(leg, "matched", null, match.price);
        } else {
          settle(leg, match.status, match.reason);
        }
      }
    })
  );

  // In the order the legs were asked for.
  const ordered = legs.map((l) => results.get(l.pickId)!);
  const matched = legs.map((l) => selections.get(l.pickId)).filter((s): s is FanDuelSelection => s !== undefined);
  return { url: buildFanDuelBetslipUrl(matched), legs: ordered };
}
