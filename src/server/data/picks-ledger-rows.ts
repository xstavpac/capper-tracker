// The /picks ledger's row model, built from a loaded pick. Shared by the page
// (its date window) and loadOlderPicksAction (older rows), so an older row
// reads exactly like a row on the first page.
import type { LedgerRow } from "@/components/picks/pick-ledger";
import { buildPickLabel, capperInitials, formatOdds, marketTag, pickPhase, winUnits, type GameFeedStatus, type LedgerPickInput, type PickPhase } from "@/lib/pick-display";
import type { getFilteredPicksForUser } from "@/server/data/picks";

export type LedgerSourcePick = Awaited<ReturnType<typeof getFilteredPicksForUser>>[number] & {
  capper: { name: string };
  sport: { name: string };
};

export type LedgerPick<P extends LedgerSourcePick = LedgerSourcePick> = LedgerPickInput & { source: P; phase: PickPhase };

export function fmtUnits(n: number): string {
  return String(Math.round(n * 100) / 100);
}

export function toLedgerPick<P extends LedgerSourcePick>(
  p: P,
  ctx: {
    now: Date;
    finalScores: Map<string, { home: number; away: number }>;
    feedStatuses: Map<string, { status: GameFeedStatus; score: { home: string; away: string } | null }>;
  }
): LedgerPick<P> {
  return {
    id: p.id,
    capperId: p.capperId,
    sportName: p.sport.name,
    homeTeam: p.homeTeam,
    awayTeam: p.awayTeam,
    betType: p.betType,
    betDetail: p.betDetail,
    line: p.line,
    period: p.period,
    pickedSide: p.pickedSide,
    odds: p.odds,
    status: p.status,
    gameTime: p.gameTime,
    category: p.category,
    phase: pickPhase({
      status: p.status,
      gameTime: p.gameTime,
      now: ctx.now,
      hasFinalResult: ctx.finalScores.has(p.id),
      feedStatus: ctx.feedStatuses.get(p.id)?.status ?? null,
    }),
    source: p,
  };
}

export function toLedgerRow(
  lp: LedgerPick,
  ctx: {
    capperRecords: Map<string, { wins: number; losses: number }>;
    finalScores: Map<string, { home: number; away: number }>;
    feedStatuses: Map<string, { status: GameFeedStatus; score: { home: string; away: string } | null }>;
    consensus: string | null;
    consensusHref: string | null;
  }
): LedgerRow {
  const p = lp.source;
  const rec = ctx.capperRecords.get(p.capperId);
  const score = ctx.finalScores.get(p.id);
  const liveScore = ctx.feedStatuses.get(p.id)?.score ?? null;
  const decidedUnits =
    p.status === "WIN"
      ? "+" + fmtUnits(winUnits(p.units, p.odds)) + "u"
      : p.status === "LOSS"
        ? "-" + fmtUnits(p.units) + "u"
        : null;
  return {
    id: p.id,
    sportName: p.sport.name,
    gameTimeIso: p.gameTime.toISOString(),
    label: buildPickLabel(lp),
    tag: marketTag({ betType: p.betType, period: p.period, sportName: p.sport.name, betDetail: p.betDetail }),
    capperId: p.capperId,
    capperName: p.capper.name,
    capperInitials: capperInitials(p.capper.name),
    capperRecord: rec ? rec.wins + "-" + rec.losses : null,
    matchup: score
      ? p.awayTeam + " " + score.away + " @ " + p.homeTeam + " " + score.home + " (Final)"
      : p.awayTeam + " @ " + p.homeTeam,
    oddsText: formatOdds(p.odds),
    unitsText: fmtUnits(p.units) + "u",
    phase: lp.phase,
    currentStatus: p.status,
    liveScore: liveScore ? liveScore.away + "-" + liveScore.home : null,
    resultUnitsText: decidedUnits,
    consensus: ctx.consensus,
    consensusHref: ctx.consensusHref,
  };
}
