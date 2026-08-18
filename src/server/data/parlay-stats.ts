import { prisma } from "@/lib/prisma";
import type { ParlayBet, Leg } from "@prisma/client";

// Deliberately its own module, not an addition to stats.ts's computeStats -
// see the schema.prisma comment on ParlayBet for why: every existing
// caller of computeStats hands it Pick[] arrays pulled from one of ~25
// prisma.pick call sites that know nothing about parlays. Adding parlay
// awareness to computeStats itself would mean either changing its signature
// (breaking all 25 callers) or silently trying to duck-type ParlayBet rows
// into the same shape as Pick, which don't actually match (no `odds` field -
// see below). A separate, purpose-built aggregator for a separate table.
export type ParlayOverallStats = {
  wins: number;
  losses: number;
  pushes: number;
  winPct: number;
  unitsWon: number;
  unitsLost: number;
  netUnits: number;
  roi: number;
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function decimalOdds(americanOdds: number): number {
  return americanOdds > 0 ? 1 + americanOdds / 100 : 1 + 100 / Math.abs(americanOdds);
}

// A won parlay's payout multiplier - the product of the decimal odds of
// only the legs that actually won. PUSH/CANCELLED legs are excluded, same
// "recalculates at N-1 legs" rule resolveParlayStatus (parlay-grading.ts)
// uses to decide the parlay's own status - there is deliberately no single
// stored "the parlay's odds" field (see the schema comment on Leg): a pushed
// leg changes the real payout, so it has to be derived from whichever legs
// actually survived to settlement, every time, not read off a static input.
export function effectiveParlayDecimalOdds(legs: { status: string; odds: number }[]): number {
  return legs.filter((l) => l.status === "WIN").reduce((product, l) => product * decimalOdds(l.odds), 1);
}

export function unitsWonOnParlay(units: number, legs: { status: string; odds: number }[]): number {
  return units * (effectiveParlayDecimalOdds(legs) - 1);
}

// Same shape/semantics as stats.ts's computeStats, minus streaks (not
// needed by anything yet - can be added the same way computeStats' were if
// a parlay-specific streak panel is ever built). PENDING and CANCELLED
// parlays are excluded from every count, same as Pick.
export function computeParlayStats(parlays: (ParlayBet & { legs: Leg[] })[]): ParlayOverallStats {
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let unitsWon = 0;
  let unitsLost = 0;
  let unitsRisked = 0;

  for (const p of parlays) {
    if (p.status === "PENDING" || p.status === "CANCELLED") continue;

    unitsRisked += p.units;

    if (p.status === "WIN") {
      wins++;
      unitsWon += unitsWonOnParlay(p.units, p.legs);
    } else if (p.status === "LOSS") {
      losses++;
      unitsLost += p.units;
    } else if (p.status === "PUSH") {
      pushes++;
    }
  }

  const decided = wins + losses;
  const netUnits = unitsWon - unitsLost;

  return {
    wins,
    losses,
    pushes,
    winPct: decided > 0 ? (wins / decided) * 100 : 0,
    unitsWon: round2(unitsWon),
    unitsLost: round2(unitsLost),
    netUnits: round2(netUnits),
    roi: unitsRisked > 0 ? round2((netUnits / unitsRisked) * 100) : 0,
  };
}

export type ParlayReportsData = {
  overall: ParlayOverallStats;
  totalParlays: number;
  pendingCount: number;
};

export async function getParlayReportsData(userId: string): Promise<ParlayReportsData> {
  const parlays = await prisma.parlayBet.findMany({
    where: { userId },
    include: { legs: true },
  });

  return {
    overall: computeParlayStats(parlays),
    totalParlays: parlays.length,
    pendingCount: parlays.filter((p) => p.status === "PENDING").length,
  };
}
