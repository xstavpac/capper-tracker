// Heavy Consensus: a market where the viewer's cappers are heavily on one side,
// and how often such a heavy side has won before. Pure and client-safe - the
// Live tab reads the per-game part from the picks it already loaded, and the
// nightly recompute (server/data/heavy-consensus.ts) runs the same functions
// over history, so the badge and its hit rate can never disagree on what
// "heavy" means.
//
// Markets: full-game MONEYLINE, SPREAD and game TOTAL, each its own market
// (Bulls ML vs Knicks ML; Bulls spread vs Knicks spread; Over vs Under). Props,
// team totals, NRFI and every period market are left out.
//
// Side: read the way the Live tab's headers read it - the pick's teamGroup
// (classifyPickTeamGroup) for ML / spread, totalSideFromText for a total - so
// the badge sits on exactly the header whose picks it counts.
//
// Cappers, not picks: a capper counts once per market. A capper on both sides
// of a market has hedged and counts on neither (the same rule as the Consensus
// Hybrid's positions, lib/parlay/consensus.ts).
//
// Point in time: only picks posted before the game started count (datePosted
// is the import time, so a pick imported after kickoff - a history backfill -
// never does). CANCELLED picks never count.
//
// Qualifies: at least HEAVY_CONSENSUS_MIN_CAPPERS cappers and a share of at
// least HEAVY_CONSENSUS_MIN_SHARE_PCT on one side. The share is ROUNDED to a
// whole percent before the check and the band, so the number on the badge and
// the band it falls in always agree.
//
// Outcome (history only): one vote per heavy-side capper - the majority of that
// capper's own WIN / LOSS picks on the side, a capper whose own picks tie casts
// no vote. More WIN votes = a hit, more LOSS votes = a miss, a tie (including
// no graded picks at all) = no outcome, left out of the rate. Pushes and voids
// drop out.
//
// The hit rate is ONE pooled number across every league and market type, and
// it is the VIEWER'S OWN: each user has their own cappers and picks, so the
// badge shows how often a heavy side has won in that user's history. It never
// pools across users - another user's picks cannot move it. Each stored market
// keeps its band so the rate can be split 80-89 / 90+ later; it is not split
// today (too few markets per band).
import type { PickStatus } from "@prisma/client";
import { totalSideFromText } from "@/lib/bet-line";
import type { PickTeamGroup } from "@/lib/pick-team-group";
import { easternDateKey } from "@/lib/dates";

export const HEAVY_CONSENSUS_MIN_CAPPERS = 8;
export const HEAVY_CONSENSUS_MIN_SHARE_PCT = 80;
// History is stored from this many cappers up, so a later change of the
// minimum above (6 / 8 / 10 were the candidates) needs no recompute.
export const HEAVY_CONSENSUS_STORE_MIN_CAPPERS = 6;

export type HeavyMarket = "MONEYLINE" | "SPREAD" | "TOTAL";
export type HeavySide = "AWAY" | "HOME" | "OVER" | "UNDER";
export type HeavyBand = "80-89" | "90+";
export type HeavyOutcome = "WIN" | "LOSS";

export const HEAVY_MARKET_LABELS: Record<HeavyMarket, string> = { MONEYLINE: "Moneyline", SPREAD: "Spread", TOTAL: "Total" };

// The fields a pick needs here. `teamGroup` is the Live tab's own group
// (ExpanderPick.teamGroup); history callers fill it from classifyPickTeamGroup.
// `betDetail` is the pick's raw stored text. Dates may be ISO strings (the
// Live tab's serialized picks) or Dates (a Prisma row).
export type ConsensusPick = {
  capperId: string;
  betType: string;
  period: string;
  betDetail: string | null;
  teamGroup: PickTeamGroup;
  status: PickStatus;
  gameTime: string | Date;
  // Absent on a Live pick persisted before the field existed: counted.
  datePosted?: string | Date;
};

export type HeavyMarketScore = {
  market: HeavyMarket;
  side: HeavySide;
  // Non-hedged cappers on the market, and those on the heavy side.
  cappers: number;
  heavyCappers: number;
  sharePct: number;
  band: HeavyBand;
  outcome: HeavyOutcome | null;
};

const MARKETS: Record<string, HeavyMarket> = { MONEYLINE: "MONEYLINE", SPREAD: "SPREAD", TOTAL: "TOTAL" };

export function heavyMarketOf(pick: Pick<ConsensusPick, "betType" | "period">): HeavyMarket | null {
  if (pick.period !== "FULL_GAME") return null;
  return MARKETS[pick.betType] ?? null;
}

export function consensusSideOf(pick: ConsensusPick): HeavySide | null {
  const market = heavyMarketOf(pick);
  if (!market) return null;
  if (market === "TOTAL") return totalSideFromText(pick.betDetail);
  return pick.teamGroup === "AWAY" || pick.teamGroup === "HOME" ? pick.teamGroup : null;
}

const time = (d: string | Date) => (typeof d === "string" ? Date.parse(d) : d.getTime());

// Counts toward consensus at all: not CANCELLED, posted before the start.
export function countsTowardConsensus(pick: ConsensusPick): boolean {
  if (pick.status === "CANCELLED") return false;
  return pick.datePosted === undefined || time(pick.datePosted) < time(pick.gameTime);
}

export function heavyBandOf(sharePct: number): HeavyBand {
  return sharePct >= 90 ? "90+" : "80-89";
}

// One market's picks (same game, same market) scored, or null when it does not
// qualify at `minCappers`. Picks that do not count or whose side cannot be read
// are ignored.
export function scoreHeavyMarket<T extends ConsensusPick>(market: HeavyMarket, picks: T[], minCappers = HEAVY_CONSENSUS_MIN_CAPPERS): HeavyMarketScore | null {
  const sidesByCapper = new Map<string, Set<HeavySide>>();
  const counted: { pick: T; side: HeavySide }[] = [];
  for (const pick of picks) {
    if (heavyMarketOf(pick) !== market || !countsTowardConsensus(pick)) continue;
    const side = consensusSideOf(pick);
    if (!side) continue;
    counted.push({ pick, side });
    sidesByCapper.set(pick.capperId, (sidesByCapper.get(pick.capperId) ?? new Set<HeavySide>()).add(side));
  }

  const perSide = new Map<HeavySide, number>();
  let cappers = 0;
  for (const sides of Array.from(sidesByCapper.values())) {
    if (sides.size !== 1) continue;
    const [side] = Array.from(sides);
    perSide.set(side, (perSide.get(side) ?? 0) + 1);
    cappers++;
  }
  if (cappers < minCappers) return null;
  const [side, heavyCappers] = Array.from(perSide.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  const sharePct = Math.round((heavyCappers / cappers) * 100);
  if (sharePct < HEAVY_CONSENSUS_MIN_SHARE_PCT) return null;

  const grades = new Map<string, { w: number; l: number }>();
  for (const { pick, side: s } of counted) {
    if (s !== side || sidesByCapper.get(pick.capperId)!.size !== 1) continue;
    const g = grades.get(pick.capperId) ?? { w: 0, l: 0 };
    if (pick.status === "WIN") g.w++;
    else if (pick.status === "LOSS") g.l++;
    grades.set(pick.capperId, g);
  }
  let wins = 0;
  let losses = 0;
  for (const g of Array.from(grades.values())) {
    if (g.w > g.l) wins++;
    else if (g.l > g.w) losses++;
  }

  return { market, side, cappers, heavyCappers, sharePct, band: heavyBandOf(sharePct), outcome: wins > losses ? "WIN" : losses > wins ? "LOSS" : null };
}

// The Live tab: at most one badge per pick header of one game. A team header
// holds both the team's ML and spread picks, so when both qualify the higher
// share wins (then more cappers, then the moneyline). The Over / Under
// headers each take their total.
export function heavyConsensusByHeader(picks: ConsensusPick[]): Partial<Record<HeavySide, HeavyMarketScore>> {
  const out: Partial<Record<HeavySide, HeavyMarketScore>> = {};
  for (const market of ["MONEYLINE", "SPREAD", "TOTAL"] as const) {
    const score = scoreHeavyMarket(market, picks);
    if (!score) continue;
    const held = out[score.side];
    if (!held || score.sharePct > held.sharePct || (score.sharePct === held.sharePct && score.cappers > held.cappers)) out[score.side] = score;
  }
  return out;
}

// ---- History ----

// A historical pick: a ConsensusPick plus the game and viewer it belongs to.
export type HistoryPick = ConsensusPick & {
  userId: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  gameNumber: number | null;
};

export type HeavyConsensusInstance = HeavyMarketScore & {
  userId: string;
  sport: string;
  // The game's Eastern date (YYYY-MM-DD), the grain of the nightly window.
  gameDate: string;
  gameTime: Date;
  // The real-world market: sport | away | home | Eastern date | game number | market | heavy side.
  worldKey: string;
};

// Every per-viewer market in `picks` that qualifies at `minCappers` (the
// stored floor by default). A game is one viewer's picks on the same teams on
// the same Eastern date (and doubleheader game number, when set).
export function buildHeavyConsensusInstances(picks: HistoryPick[], minCappers = HEAVY_CONSENSUS_STORE_MIN_CAPPERS): HeavyConsensusInstance[] {
  const markets = new Map<string, { gameKey: string; market: HeavyMarket; picks: HistoryPick[] }>();
  for (const p of picks) {
    const market = heavyMarketOf(p);
    if (!market) continue;
    const gameKey = [p.sport, p.awayTeam, p.homeTeam, easternDateKey(new Date(p.gameTime)), p.gameNumber ?? "-"].join("|");
    const key = p.userId + "\u0000" + gameKey + "\u0000" + market;
    const m = markets.get(key) ?? { gameKey, market, picks: [] };
    m.picks.push(p);
    markets.set(key, m);
  }

  const out: HeavyConsensusInstance[] = [];
  for (const m of Array.from(markets.values())) {
    const score = scoreHeavyMarket(m.market, m.picks, minCappers);
    if (!score) continue;
    const first = m.picks[0];
    const gameTime = new Date(Math.min(...m.picks.map((p) => time(p.gameTime))));
    out.push({
      ...score,
      userId: first.userId,
      sport: first.sport,
      gameDate: easternDateKey(new Date(first.gameTime)),
      gameTime,
      worldKey: m.gameKey + "|" + m.market + "|" + score.side,
    });
  }
  return out;
}

// What the rate reads back from storage.
export type StoredHeavyMarket = Pick<HeavyConsensusInstance, "userId" | "cappers" | "outcome">;

export type HeavyConsensusRate = {
  // Rounded; null when no qualifying market has an outcome yet.
  hitRatePct: number | null;
  // Real-world markets with an outcome - the "Based on N games".
  games: number;
};

// The viewer's hit rate, pooled across every league and market type: their
// stored markets at `minCappers` or more, outcome-less ones left out. A viewer's
// markets are already one per real-world market (unique per userId + worldKey),
// so nothing is de-duplicated. Rows of any other user are ignored here as well
// as by the read, so passing a wider set can never change the answer.
export function viewerHeavyConsensusRate(rows: StoredHeavyMarket[], viewerId: string, minCappers = HEAVY_CONSENSUS_MIN_CAPPERS): HeavyConsensusRate {
  let games = 0;
  let hits = 0;
  for (const r of rows) {
    if (r.userId !== viewerId || r.cappers < minCappers || r.outcome === null) continue;
    games++;
    if (r.outcome === "WIN") hits++;
  }
  return { hitRatePct: games === 0 ? null : Math.round((hits / games) * 100), games };
}

// ---- The Live badge ----

export type HeavyBadge = {
  market: HeavyMarket;
  sharePct: number;
  heavyCappers: number;
  cappers: number;
  hitRatePct: number;
  games: number;
};

// One game's badges by header, ready to render: a Live pick's raw text is
// `rawBetDetail` (its `betDetail` is the display label). None at all when the
// rate has nothing behind it yet.
export function heavyBadgesForGame(
  picks: (Omit<ConsensusPick, "betDetail"> & { betDetail: string | null; rawBetDetail?: string | null })[],
  rate: HeavyConsensusRate | null
): Partial<Record<HeavySide, HeavyBadge>> {
  if (!rate || rate.hitRatePct === null) return {};
  const byHeader = heavyConsensusByHeader(picks.map((p) => ({ ...p, betDetail: p.rawBetDetail !== undefined ? p.rawBetDetail : p.betDetail })));
  const out: Partial<Record<HeavySide, HeavyBadge>> = {};
  for (const [side, s] of Object.entries(byHeader) as [HeavySide, HeavyMarketScore][]) {
    out[side] = { market: s.market, sharePct: s.sharePct, heavyCappers: s.heavyCappers, cappers: s.cappers, hitRatePct: rate.hitRatePct, games: rate.games };
  }
  return out;
}

// The pill's text, exactly: "HEAVY CONS 82% · HIT RATE 46%".
export const heavyBadgeText = (b: Pick<HeavyBadge, "sharePct" | "hitRatePct">) => `HEAVY CONS ${b.sharePct}% · HIT RATE ${b.hitRatePct}%`;

// The tap / hover details: "Moneyline · 9 of 10 cappers · Based on 92 games".
export const heavyBadgeDetails = (b: HeavyBadge) =>
  `${HEAVY_MARKET_LABELS[b.market]} · ${b.heavyCappers} of ${b.cappers} cappers · Based on ${b.games} game${b.games === 1 ? "" : "s"}`;
