// Consensus Hybrid's view-model: everything the Generator card's Hybrid mode
// shows, decided here so the components stay thin. Pure and client-safe: no I/O,
// no clock (times are formatted by an injected function), no React.
//
//   - price display ("-135", "+120", "+100" for even money)
//   - the settings form -> a HybridGenerateSettings, with its validation
//   - target status (in range / just outside / closest match)
//   - the box in plain words (and a fallback when the optimizer sent none)
//   - one compact line per leg: pick + price, consensus, reason
//   - which state the page is in (idle .. result), from the action's response
//   - Legs per game: 2 · 3 · Auto (boxLegs), and Total legs: a 2-25 cap on the whole
//     parlay (maxLegs); a multi-box result: delivery, one row per game's box
//   - "Why only N games?": the games with picks left out, by reason, then one by one
//   - the Send to FanDuel outcome: the link legs, "no longer posted", and the
//     price-moved diff with the re-priced combined estimate
//
// The optimizer (hybrid.ts) and the actions are used as they are.
import { combineOdds, decimalToAmerican, hasUsablePrice } from "@/lib/parlay/combine-odds";
import {
  distanceToBand,
  HYBRID_DEFAULT_MAX_LEGS,
  HYBRID_DEFAULT_TARGET_MAX,
  HYBRID_DEFAULT_TARGET_MIN,
  HYBRID_MAX_LEGS,
  HYBRID_MIN_LEG_PRICE,
  impliedProbability,
  jointImplied,
  targetBand,
  type Hybrid,
  type HybridBoxLegs,
  type HybridDelivery,
  type HybridLeg,
  type HybridWidth,
  type PricedLeg,
} from "@/lib/parlay/hybrid";
import type { HybridGenerateSettings } from "@/lib/parlay/hybrid-request";
import { HYBRID_LINK_MAX_LEGS, STALE_REASON, type HybridLinkLegInput, type HybridLinkResponse } from "@/lib/parlay/hybrid-link";
import { GATE_DEFAULT } from "@/lib/parlay/gate";
import type { HybridEventNote, HybridGenerateResponse } from "@/server/data/hybrid-generate";
import type { HybridDiagnostics } from "@/lib/parlay/hybrid-diagnostics";

// ---- Copy (pinned by the tests) ----

export const MODE_NOTE = "Hybrid builds from capper consensus. Your slip isn't used in this mode.";
export const WIDTH_HINT = "Balanced ignores each team's single biggest outlier game.";
export const FOOTER_NOTE = "Consensus is a signal, not a guarantee.";
export const FINAL_PRICE_NOTE = "FanDuel shows final price";
export const SEND_NOTE = "FanDuel will show the final same-game parlay price.";
export const STALE_NOTE = "Prices may be out of date";
export const GENERIC_ERROR = "Couldn't build a hybrid right now. Try again in a moment.";
export const ALT_LINES_NOTE = "FanDuel posts alternate lines for some games on game day.";
export const PRICING_NOTE = "Another user is pricing this game, try again in a moment.";
export const UNAVAILABLE_NOTE = "Live alternate prices are unavailable right now.";
export const NO_BOX_NOTE = "No game has qualifying consensus on both a side and a total.";
export const IN_TARGET_TEXT = "✓ In your target";
export const FAR_TARGET_TEXT = "Closest match · outside your range";
// The consensus line of a 3-leg box's third leg, which has no cappers of its own.
export const OPPOSITE_LEG_TEXT = "Boxes the total from the other side";
export const BUDGET_NOTE = "Today's FanDuel price lookups are used up, so some games were skipped. Games with prices on file are still used.";
export const LINK_TOO_MANY_TEXT = "Send to FanDuel isn't available yet for more than 4 legs. Place this parlay's legs on FanDuel by hand.";

// ---- Prices ----

// "-135", "+120". Even money is "+100" either way it was posted. Not a price: "—".
export function formatPrice(american: number): string {
  if (!Number.isFinite(american)) return "—";
  const r = Math.round(american);
  if (Math.abs(r) < 100) return "—";
  if (r === -100) return "+100";
  return (r > 0 ? "+" : "-") + Math.abs(r).toLocaleString("en-US");
}

// A typed price ("-140", "−140", "+120", "120") -> American odds, null when it isn't one.
export function parsePrice(text: string): number | null {
  const t = text.trim().replace(/−/g, "-").replace(/^\+/, "").replace(/,/g, "");
  if (!/^-?\d+$/.test(t)) return null;
  const n = Number(t);
  return hasUsablePrice(n) && Math.abs(n) <= 100000 ? n : null;
}

// What a field shows once it has been committed: signed, with the proper minus.
export function normalizePriceText(text: string): string {
  const n = parsePrice(text);
  return n === null ? text : formatPrice(n);
}

// ---- The settings form ----

export type HybridForm = {
  targetMin: string;
  targetMax: string;
  width: HybridWidth;
  // Legs per game: 2 · 3 · Auto.
  boxLegs: HybridBoxLegs;
  // Total legs: a cap on the whole parlay, 2-25.
  maxLegs: number;
  minWinPct: number;
  // The per-leg price range sits behind "Advanced" and is off by default.
  advanced: boolean;
  legMin: string;
  legMax: string;
};

export const DEFAULT_FORM: HybridForm = {
  targetMin: formatPrice(HYBRID_DEFAULT_TARGET_MIN),
  targetMax: formatPrice(HYBRID_DEFAULT_TARGET_MAX),
  width: "balanced",
  boxLegs: "auto",
  maxLegs: HYBRID_DEFAULT_MAX_LEGS,
  minWinPct: GATE_DEFAULT,
  advanced: false,
  legMin: "",
  legMax: "",
};

export type FormErrors = { target?: string; perLeg?: string };

export function buildSettings(form: HybridForm): { ok: true; settings: HybridGenerateSettings } | { ok: false; errors: FormErrors } {
  const errors: FormErrors = {};
  const targetMin = parsePrice(form.targetMin);
  const targetMax = parsePrice(form.targetMax);
  if (targetMin === null || targetMax === null) errors.target = "Enter both target prices as American odds, like -140 or +120.";
  else if (targetMin > targetMax) errors.target = `Min can't be higher than max. Put the longer price second, like ${formatPrice(-140)} to ${formatPrice(-110)}.`;

  let perLegRange: HybridGenerateSettings["perLegRange"] = null;
  if (form.advanced && (form.legMin.trim() !== "" || form.legMax.trim() !== "")) {
    const min = parsePrice(form.legMin);
    const max = parsePrice(form.legMax);
    if (min === null || max === null) errors.perLeg = "Enter both ends of the per-leg range as American odds, or leave both empty.";
    else if (min > max) errors.perLeg = "Per-leg min can't be higher than max.";
    else if (max < HYBRID_MIN_LEG_PRICE) errors.perLeg = `No leg is priced shorter than ${formatPrice(HYBRID_MIN_LEG_PRICE)}, so that range can't match anything.`;
    else perLegRange = { min, max };
  }
  if (errors.target || errors.perLeg || targetMin === null || targetMax === null) return { ok: false, errors };
  return { ok: true, settings: { targetMin, targetMax, width: form.width, perLegRange, maxLegs: clampTotalLegs(form.maxLegs, form.boxLegs), minWinPct: form.minWinPct, boxLegs: form.boxLegs } };
}

// ---- Legs per game: 2 · 3 · Auto, and Total legs: the cap ----

export const BOX_LEGS_OPTIONS: { key: HybridBoxLegs; label: string }[] = [
  { key: "2", label: "2 Legs" },
  { key: "3", label: "3 Legs" },
  { key: "auto", label: "Auto" },
];
export const BOX_LEGS_HINT = "Auto uses 2 legs when possible and adds a third when needed.";
export const TOTAL_LEGS_HINT = "A cap, not a target: the parlay is built from whole games' boxes, one per game.";
// Target odds apply to each game's box once the cap leaves room for more than one.
export const MULTI_BOX_FROM = 4;
export const TARGET_ODDS_PER_GAME_HINT = "Each game's box is tuned to this range.";

export function targetOddsLabel(maxLegs: number): string {
  return maxLegs >= MULTI_BOX_FROM ? "Target odds (per game)" : "Target odds";
}

// The fewest total legs a box choice allows: only "3 Legs" needs room for a third.
export function minTotalLegs(boxLegs: HybridBoxLegs): number {
  return boxLegs === "3" ? 3 : 2;
}

// A whole number from the choice's floor to the engine's cap (a bad value falls to the floor).
export function clampTotalLegs(n: number, boxLegs: HybridBoxLegs): number {
  const floor = minTotalLegs(boxLegs);
  return Math.max(floor, Math.min(HYBRID_MAX_LEGS, Math.floor(n) || floor));
}

// Picking "3 Legs" raises Total legs to 3 when it is below; the other choices leave it.
export function boxLegsPatch(form: Pick<HybridForm, "maxLegs">, boxLegs: HybridBoxLegs): Pick<HybridForm, "boxLegs" | "maxLegs"> {
  return { boxLegs, maxLegs: boxLegs === "3" && form.maxLegs < 3 ? 3 : form.maxLegs };
}

// ---- Target status ----

// Implied-probability points outside the band that still read as "just outside".
export const NEAR_RANGE = 0.03;

export type TargetStatus = { kind: "in" | "near" | "far"; text: string };

export function targetStatus(american: number, range: { targetMin: number; targetMax: number }): TargetStatus {
  const p = impliedProbability(american);
  if (p === null) return { kind: "far", text: FAR_TARGET_TEXT };
  const d = distanceToBand(p, targetBand(range));
  if (d === 0) return { kind: "in", text: IN_TARGET_TEXT };
  if (d <= NEAR_RANGE) return { kind: "near", text: `${formatPrice(american)} · just outside your range` };
  return { kind: "far", text: FAR_TARGET_TEXT };
}

// ---- A hybrid, in words ----

export function boxText(h: Hybrid): string {
  const given = h.boxDescription?.trim();
  if (given) return given;
  const labels = h.legs.map((l) => l.label);
  if (labels.length === 0) return "";
  const joined = labels.length <= 2 ? labels.join(" and ") : labels.slice(0, -1).join(", ") + " and " + labels[labels.length - 1];
  return "Wins if " + joined;
}

export function combinedPrice(h: Hybrid, american = h.combinedAmerican): { text: string; note: string | null } {
  return h.isEstimate ? { text: "≈ " + formatPrice(american), note: FINAL_PRICE_NOTE } : { text: formatPrice(american), note: null };
}

const RECORD_NOUN: Record<HybridLeg["consensus"]["topSupporters"][number]["recordMarket"], string> = { SPREAD: "spreads", MONEYLINE: "moneylines", TOTAL: "totals" };

// "5 cappers · 61% NFL spreads (n=212)": the top supporter's record, and its sample size.
// The noun is the market that record is for (the data's recordMarket), not the leg's rung.
export function consensusLine(leg: HybridLeg): string {
  if (leg.opposite) return OPPOSITE_LEG_TEXT;
  const n = leg.consensus.supporters;
  const head = `${n} capper${n === 1 ? "" : "s"}`;
  const top = leg.consensus.topSupporters[0];
  if (!top) return head;
  const scope = top.record === "LEAGUE" ? leg.sport : "all leagues";
  return `${head} · ${Math.round(top.winPct)}% ${scope} ${RECORD_NOUN[top.recordMarket]} (n=${top.n})`;
}

// The optimizer's reason opens with the pick's own label, which the row already
// shows; what is left reads "tonight +3.5 · their games miss the spread by up to 8".
// A leg placed on raw scores always says so.
export function reasonLine(leg: HybridLeg): string {
  const lead = leg.label + " · ";
  let text = leg.reason.startsWith(lead) ? leg.reason.slice(lead.length) : leg.reason === leg.label ? "" : leg.reason;
  if (leg.edgeSource === "raw" && !text.includes("raw scores")) text = text ? text + " · raw scores" : "raw scores";
  return text;
}

export function hybridGames(h: Hybrid, formatTime: (iso: string) => string): { eventId: string; text: string }[] {
  const seen = new Set<string>();
  const out: { eventId: string; text: string }[] = [];
  for (const l of h.legs) {
    if (seen.has(l.eventId)) continue;
    seen.add(l.eventId);
    out.push({ eventId: l.eventId, text: `${l.sport} · ${l.awayTeam} @ ${l.homeTeam} · ${formatTime(l.commenceTime)}` });
  }
  return out;
}

export type LegView = { key: string; title: string; price: string; consensus: string; reason: string; game: string | null };

export function legViews(h: Hybrid): LegView[] {
  const multi = new Set(h.legs.map((l) => l.eventId)).size > 1;
  return h.legs.map((l) => ({
    key: l.positionKey,
    title: l.label,
    price: formatPrice(l.price),
    consensus: consensusLine(l),
    reason: reasonLine(l),
    game: multi ? `${l.awayTeam} @ ${l.homeTeam}` : null,
  }));
}

export function oddsAsOfText(iso: string | null, formatTime: (iso: string) => string): string | null {
  return iso ? `Odds as of ${formatTime(iso)}` : null;
}

// ---- A multi-box result: one row per game's box ----

export function isMultiBox(h: Hybrid): boolean {
  return h.structure === "multi-box" && (h.boxes?.length ?? 0) > 0;
}

export type DeliveryView = { text: string; short: boolean };

// "Delivered 6 of 15 legs · only 3 games qualified". Null under the multi-box range (Total legs below 4).
export function deliveryView(d: HybridDelivery): DeliveryView | null {
  if (d.requestedLegs < MULTI_BOX_FROM) return null;
  const head = `Delivered ${d.deliveredLegs} of ${d.requestedLegs} legs`;
  if (d.shortOfGames && d.qualifyingGames > 0) return { text: `${head} · only ${d.qualifyingGames} game${d.qualifyingGames === 1 ? "" : "s"} qualified`, short: true };
  if (d.deliveredLegs < d.requestedLegs && !d.shortOfGames) return { text: `${head} · boxes are whole games`, short: false };
  return { text: head, short: d.shortOfGames };
}

export type BoxView = { key: string; game: string; description: string; price: { text: string; note: string | null }; status: TargetStatus; legs: LegView[] };

export function boxViews(h: Hybrid, range: { targetMin: number; targetMax: number }): BoxView[] {
  return (h.boxes ?? []).map((b) => {
    const first = b.legs[0];
    return {
      key: first.eventId,
      game: `${first.sport} · ${first.awayTeam} @ ${first.homeTeam}`,
      description: boxText(b),
      price: combinedPrice(b),
      status: targetStatus(b.combinedAmerican, range),
      legs: legViews(b),
    };
  });
}

// The band applies to each box, so the combined price has no target of its own: say how many boxes made it.
export function boxesInTargetText(h: Hybrid): TargetStatus {
  const boxes = h.boxes ?? [];
  const inBand = boxes.filter((b) => b.inTarget).length;
  if (inBand === boxes.length) return { kind: "in", text: `✓ All ${boxes.length} games in your target` };
  return { kind: "far", text: `${inBand} of ${boxes.length} games in your target` };
}

// Send to FanDuel works for up to HYBRID_LINK_MAX_LEGS legs (the response says so; the leg count is the fallback).
export function canSendToFanDuel(h: Hybrid, linkable: boolean | undefined): boolean {
  return linkable !== false && h.legs.length <= HYBRID_LINK_MAX_LEGS;
}

// ---- "Why only N games?" ----

export type WhyView = {
  title: string;
  summary: string;
  counts: { key: string; label: string; count: number }[];
  rows: { key: string; game: string; picks: string; text: string }[];
};

// Null when nothing with picks was left out (or an older response has no diagnostics).
export function whySkippedView(d: HybridDiagnostics | null | undefined): WhyView | null {
  if (!d || d.skipped.length === 0) return null;
  const n = d.gamesUsed;
  const left = d.skipped.length;
  return {
    title: n === 0 ? "Why no games?" : `Why only ${n} game${n === 1 ? "" : "s"}?`,
    summary: `${left} of ${d.gamesWithPicks} game${d.gamesWithPicks === 1 ? "" : "s"} with picks left out`,
    counts: d.counts.map((c) => ({ key: c.reason, label: c.label, count: c.count })),
    rows: d.skipped.map((r, i) => ({ key: r.eventId + "|" + i, game: `${r.leagueName} · ${r.gameLabel}`, picks: `${r.picks} pick${r.picks === 1 ? "" : "s"}`, text: r.text })),
  };
}

export type HybridCardKey = "primary" | "alt-1" | "alt-2";

export function cardTabs(response: HybridGenerateResponse): { key: HybridCardKey; label: string }[] {
  const tabs: { key: HybridCardKey; label: string }[] = [];
  if (response.result.primary) tabs.push({ key: "primary", label: "Primary" });
  response.result.alternates.slice(0, 2).forEach((_, i) => tabs.push({ key: i === 0 ? "alt-1" : "alt-2", label: `Alt ${i + 1}` }));
  return tabs;
}

export function hybridFor(response: HybridGenerateResponse, key: HybridCardKey): Hybrid | null {
  if (key === "primary") return response.result.primary;
  return response.result.alternates[key === "alt-1" ? 0 : 1] ?? null;
}

// ---- Which state the page is in ----

export type PageInput = {
  phase: "idle" | "loading" | "done" | "error";
  response: HybridGenerateResponse | null;
  // The message of an action rejection, or null for a thrown / unknown failure.
  errorMessage: string | null;
  // The settings the response was built with.
  settings: Pick<HybridGenerateSettings, "targetMin" | "targetMax">;
};

export type ResultFlags = {
  // The primary is outside the target: "closest match".
  outsideTarget: boolean;
  // No game had a box; the primary is built from different games (exact price).
  crossGame: boolean;
  // Games whose alternate lines FanDuel hasn't posted yet / another request is pricing.
  skippedGames: string[];
  pricingGames: string[];
  // Games FanDuel's lines couldn't be priced for (credit budget, usage gate, API failure).
  unavailableGames: string[];
  // The primary rests on prices that couldn't be refreshed.
  stale: boolean;
  // Some games weren't priced because the daily credit budget or the usage gate stopped it.
  budgetLimited: boolean;
};

export type PageState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "result"; flags: ResultFlags }
  | { kind: "no-fit"; flags: ResultFlags }
  | { kind: "no-box"; message: string; detail: string | null }
  | { kind: "alt-lines-not-posted"; games: string[] }
  | { kind: "pricing-in-progress"; games: string[] }
  | { kind: "prices-unavailable"; games: string[] };

const gamesOf = (notes: HybridEventNote[], kind: HybridEventNote["kind"]) => notes.filter((n) => n.kind === kind).map((n) => n.gameLabel);

export function pageState(input: PageInput): PageState {
  if (input.phase === "idle") return { kind: "idle" };
  if (input.phase === "loading") return { kind: "loading" };
  if (input.phase === "error" || !input.response) return { kind: "error", message: input.errorMessage ?? GENERIC_ERROR };

  const { result, notes, candidateEvents } = input.response;
  const skippedGames = gamesOf(notes, "alt-lines-not-posted");
  const pricingGames = gamesOf(notes, "pricing-in-progress");
  const unavailableGames = gamesOf(notes, "ladders-unavailable");
  const primary = result.primary;

  if (!primary) {
    if (pricingGames.length > 0) return { kind: "pricing-in-progress", games: pricingGames };
    if (unavailableGames.length > 0) return { kind: "prices-unavailable", games: unavailableGames };
    if (skippedGames.length > 0) return { kind: "alt-lines-not-posted", games: skippedGames };
    if (candidateEvents.length === 0) return { kind: "no-box", message: NO_BOX_NOTE, detail: null };
    return { kind: "no-box", message: NO_BOX_NOTE, detail: result.note };
  }

  const flags: ResultFlags = {
    outsideTarget: !primary.inTarget,
    crossGame: primary.structure === "cross-game",
    skippedGames,
    pricingGames,
    unavailableGames,
    stale: primary.anyStale,
    budgetLimited: notes.some((n) => n.kind === "ladders-unavailable" && (n.cause === "budget" || n.cause === "usage-gate")),
  };
  return { kind: flags.outsideTarget ? "no-fit" : "result", flags };
}

export function crossGameText(h: Hybrid): string {
  return `${NO_BOX_NOTE} Built from ${h.legs.length === 2 ? "two different" : "different"} games, so the price is exact.`;
}

// ---- Send to FanDuel ----

const legKey = (l: { eventId: string; marketKey: string; outcomeName: string; point: number | null }) => `${l.eventId}|${l.marketKey}|${l.outcomeName}|${l.point}`;

// The legs hybridFanDuelLinkAction takes; null when a leg's sport key is unknown (nothing to send).
export function linkLegs(h: Hybrid, eventSportKeys: Record<string, string>): HybridLinkLegInput[] | null {
  const out: HybridLinkLegInput[] = [];
  for (const l of h.legs) {
    const sportKey = eventSportKeys[l.eventId];
    if (!sportKey) return null;
    out.push({ eventId: l.eventId, sportKey, marketKey: l.marketKey, outcomeName: l.outcomeName, point: l.point });
  }
  return out;
}

export type PriceMove = { label: string; from: number; to: number; text: string };

// The legs whose FanDuel price now differs from the one the hybrid was built with,
// and the combined estimate re-priced with FanDuel's current prices.
export function priceMoves(h: Hybrid, link: HybridLinkResponse): { moves: PriceMove[]; combined: { text: string; american: number } | null } {
  const byKey = new Map(h.legs.map((l) => [legKey(l), l]));
  const moves: PriceMove[] = [];
  const nowPrices: number[] = [];
  const priced: PricedLeg[] = [];
  for (const r of link.legs) {
    if (r.status !== "matched") continue;
    nowPrices.push(r.price);
    const shown = byKey.get(legKey(r.leg));
    if (shown) priced.push({ eventId: shown.eventId, family: shown.family, direction: shown.direction, point: shown.point, price: r.price });
    if (shown && shown.price !== r.price) moves.push({ label: shown.label, from: shown.price, to: r.price, text: `${shown.label} moved ${formatPrice(shown.price)} → ${formatPrice(r.price)}` });
  }
  if (moves.length === 0 || nowPrices.length !== h.legs.length) return { moves, combined: null };
  // A boxed total re-prices as pOver + pUnder - 1, like the optimizer (jointImplied).
  if (h.legs.some((l) => l.opposite)) {
    const joint = priced.length === h.legs.length ? jointImplied(priced) : null;
    const american = joint === null ? null : decimalToAmerican(1 / joint);
    return { moves, combined: american === null ? null : { american, text: combinedPrice(h, american).text } };
  }
  const c = combineOdds(nowPrices.map((odds) => ({ odds })));
  if (c.status !== "AVAILABLE") return { moves, combined: null };
  return { moves, combined: { american: c.american, text: combinedPrice(h, c.american).text } };
}


// "FanDuel's odds couldn't be refreshed (as of 3:12 PM) - try again."
export function staleText(staleAsOf: string | null | undefined, formatTime: (iso: string) => string): string {
  return STALE_REASON + (staleAsOf ? ` (as of ${formatTime(staleAsOf)})` : "") + " - try again.";
}

export type LinkView =
  | { kind: "ready"; url: string; moves: PriceMove[]; combined: { text: string; american: number; status: TargetStatus } | null }
  | { kind: "blocked"; lines: string[]; stale: boolean };

function nearestText(leg: HybridLeg | undefined, point: number | null, price: number): string {
  const where = point === null ? "" : leg?.family === "TOTAL" ? String(point) : point > 0 ? "+" + point : String(point);
  return where ? `Nearest is ${where} at ${formatPrice(price)}.` : `FanDuel has it at ${formatPrice(price)}.`;
}

export function linkView(h: Hybrid, link: HybridLinkResponse, range: { targetMin: number; targetMax: number }, formatTime: (iso: string) => string): LinkView {
  if (link.url) {
    const { moves, combined } = priceMoves(h, link);
    return { kind: "ready", url: link.url, moves, combined: combined && { ...combined, status: targetStatus(combined.american, range) } };
  }
  const byKey = new Map(h.legs.map((l) => [legKey(l), l]));
  const lines: string[] = [];
  for (const r of link.legs) {
    if (r.status !== "gone") continue;
    const shown = byKey.get(legKey(r.leg));
    const label = shown?.label ?? `${r.leg.outcomeName}${r.leg.point === null ? "" : " " + r.leg.point}`;
    if (r.stale) lines.push(staleText(link.staleAsOf, formatTime));
    else if (r.nearest) lines.push(`${label} is no longer posted. ${nearestText(shown, r.nearest.point, r.nearest.price)}`);
    else lines.push(`${label}: ${r.reason}`);
  }
  return { kind: "blocked", lines, stale: link.anyStale };
}
