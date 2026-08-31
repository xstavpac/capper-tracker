import { prisma } from "@/lib/prisma";
import type { BetType, Period, PickStatus } from "@prisma/client";
import { recomputeParlayBetStatus } from "@/server/data/parlay-grading";

export type LegCreateInput = {
  sportId: string;
  leagueId?: string;
  homeTeam: string;
  awayTeam: string;
  betType: BetType;
  betDetail?: string;
  odds: number;
  line: number | null;
  period: Period;
  gameTime: Date;
};

export async function createParlayBet(
  userId: string,
  data: { capperId: string; units: number; notes?: string; legs: LegCreateInput[] }
) {
  const capper = await prisma.capper.findFirst({ where: { id: data.capperId, userId } });
  if (!capper) {
    throw new Error("Capper not found.");
  }

  return prisma.parlayBet.create({
    data: {
      userId,
      capperId: data.capperId,
      units: data.units,
      notes: data.notes,
      // legIndex assigned from array position at creation time - fine for a
      // manually-entered parlay where legs are only ever appended/reordered
      // before submit, never edited after the fact (there's no edit-legs UI).
      legs: {
        create: data.legs.map((leg, i) => ({
          legIndex: i,
          sportId: leg.sportId,
          leagueId: leg.leagueId || null,
          homeTeam: leg.homeTeam,
          awayTeam: leg.awayTeam,
          betType: leg.betType,
          betDetail: leg.betDetail,
          odds: leg.odds,
          line: leg.line,
          period: leg.period,
          gameTime: leg.gameTime,
        })),
      },
    },
    include: { legs: true },
  });
}

// Permanently removes one ParlayBet and, via the schema's
// Leg.onDelete: Cascade, every leg under it. Scoped by id + userId ONLY
// (standing project rule). Individual legs are deliberately never deletable
// on their own - a parlay's stake and effective payout are defined by its
// original leg set, and legIndex is a unique key assigned once at creation;
// removing one leg would leave a malformed bet. The correct fix for a
// mis-entered parlay is to delete the whole thing and re-enter it.
export async function deleteParlayBet(userId: string, parlayBetId: string): Promise<void> {
  const { count } = await prisma.parlayBet.deleteMany({ where: { id: parlayBetId, userId } });
  if (count === 0) {
    throw new Error("Parlay not found.");
  }
}

export async function getParlaysForUser(userId: string) {
  return prisma.parlayBet.findMany({
    where: { userId },
    include: {
      capper: true,
      legs: { include: { sport: true, league: true }, orderBy: { legIndex: "asc" } },
    },
    orderBy: { datePosted: "desc" },
  });
}

// Manual override for one leg's status - the parlay counterpart of
// updatePickStatus (picks.ts). Unlike a plain Pick, correcting a leg also
// has to trigger a parent recompute afterward: a manual leg correction may
// be exactly the piece of information a still-PENDING parlay was waiting on
// (or, if the parlay already resolved, recomputeParlayBetStatus's own
// PENDING guard makes this a harmless no-op - see its comment).
export async function updateLegStatus(userId: string, legId: string, status: PickStatus) {
  const leg = await prisma.leg.findFirst({
    where: { id: legId, parlayBet: { userId } },
  });
  if (!leg) {
    throw new Error("Leg not found.");
  }

  const wasPending = leg.status === "PENDING";
  await prisma.leg.update({
    where: { id: legId },
    data: { status, ...(wasPending && status !== "PENDING" ? { gradedAt: new Date() } : {}) },
  });

  await recomputeParlayBetStatus(leg.parlayBetId);
}
