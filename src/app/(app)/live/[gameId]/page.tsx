import Link from "next/link";
import { requireUser } from "@/server/auth";
import {
  getOddsForSport,
  getLiveScoresForSport,
  matchScoreToGame,
  LIVE_SPORTS,
  RESOLVABLE_SPORT_KEYS,
} from "@/server/data/odds";
import { persistFinalScores, gradePendingPicks, regradeFuzzyMatchedPicks } from "@/server/data/grading";
import { getPicksForGame, getCapperScorecard } from "@/server/data/picks";
import { betTypeLabel } from "@/server/data/stats";
import { PickStatusButtons } from "@/components/dashboard/pick-status-buttons";
import { CapperScorecard } from "@/components/dashboard/capper-scorecard";
import type { BetType, Period } from "@prisma/client";

function formatOdds(price: number) {
  return price > 0 ? "+" + price : String(price);
}

function findMarket(bookmaker: any, key: string) {
  return bookmaker?.markets?.find((m: any) => m.key === key);
}

export default async function GameDetailPage({
  params,
  searchParams,
}: {
  params: { gameId: string };
  searchParams: { sport?: string };
}) {
  const user = await requireUser();
  const sportMeta = LIVE_SPORTS.find((s) => s.key === searchParams.sport);

  if (!sportMeta) {
    return (
      <div className="mx-auto max-w-2xl">
        <Link href="/live" className="text-sm text-brand-600">
          &larr; Back to Live
        </Link>
        <div className="mt-4 rounded-card bg-white p-10 text-center shadow-soft">
          <p className="text-sm text-gray-400">Missing or unknown sport.</p>
        </div>
      </div>
    );
  }

  // A game can go final without the user ever visiting /picks (which is the
  // only other place grading normally runs) - grade this one sport here too,
  // so a finished game's picks don't sit stuck on PENDING while its card
  // already shows FINAL. Scoped to just this game's sport (not the full
  // RESOLVABLE_SPORT_KEYS loop /picks does) since only one sport is in view.
  if (RESOLVABLE_SPORT_KEYS.includes(sportMeta.key)) {
    try {
      await persistFinalScores(sportMeta.key);
      await gradePendingPicks(user.id, sportMeta.label, sportMeta.key);
      await regradeFuzzyMatchedPicks(user.id, sportMeta.label, sportMeta.key);
    } catch {
      // Best-effort, same as /picks - don't block the page on a fetch failure.
    }
  }

  const odds = await getOddsForSport(sportMeta.key);
  const game = odds.find((g) => g.id === params.gameId);

  if (!game) {
    return (
      <div className="mx-auto max-w-2xl">
        <Link href={"/live?sport=" + sportMeta.key} className="text-sm text-brand-600">
          &larr; Back to Live
        </Link>
        <div className="mt-4 rounded-card bg-white p-10 text-center shadow-soft">
          <p className="text-sm text-gray-400">
            This game isn&apos;t in today&apos;s odds anymore - odds refresh daily, so a game from an
            earlier day won&apos;t show up here.
          </p>
        </div>
      </div>
    );
  }

  const scores = await getLiveScoresForSport(sportMeta.key);
  const score = matchScoreToGame(scores, game);
  const isLive = score?.status === "live";
  const isFinal = score?.status === "final";

  const matchedPicks = await getPicksForGame(user.id, {
    sportName: sportMeta.label,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    commenceTime: new Date(game.commenceTime),
  });

  const recordKeys = new Map<
    string,
    { capperId: string; capperName: string; betType: BetType; period: Period }
  >();
  for (const pick of matchedPicks) {
    const key = pick.capperId + "|" + pick.betType + "|" + pick.period;
    if (!recordKeys.has(key)) {
      recordKeys.set(key, {
        capperId: pick.capperId,
        capperName: pick.capper.name,
        betType: pick.betType,
        period: pick.period,
      });
    }
  }

  const capperRecords = await Promise.all(
    Array.from(recordKeys.values()).map(async (entry) => ({
      ...entry,
      buckets: await getCapperScorecard(user.id, entry.capperId, { betType: entry.betType, period: entry.period }),
    }))
  );

  const book = game.bookmakers[0];
  const findMarketAcrossBooks = (key: string) => {
    for (const b of game.bookmakers) {
      const m = findMarket(b, key);
      if (m) return m;
    }
    return undefined;
  };
  const h2h = findMarketAcrossBooks("h2h");
  const spreads = findMarketAcrossBooks("spreads");
  const totals = findMarketAcrossBooks("totals");
  const homeH2h = h2h?.outcomes.find((o: any) => o.name === game.homeTeam);
  const awayH2h = h2h?.outcomes.find((o: any) => o.name === game.awayTeam);
  const homeSpread = spreads?.outcomes.find((o: any) => o.name === game.homeTeam);
  const awaySpread = spreads?.outcomes.find((o: any) => o.name === game.awayTeam);
  const over = totals?.outcomes.find((o: any) => o.name === "Over");

  return (
    <div className="mx-auto max-w-2xl">
      <Link href={"/live?sport=" + sportMeta.key} className="text-sm text-brand-600">
        &larr; Back to Live
      </Link>

      <div className="mt-3 rounded-card bg-white p-5 shadow-soft">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-xs text-gray-400">
            {new Date(game.commenceTime).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
            {book && " - " + book.title}
          </div>
          {isLive && (
            <span className="flex items-center gap-1.5">
              {score?.inningHalf && score?.inningOrdinal && (
                <span className="text-xs text-gray-500">
                  {score.inningHalf} {score.inningOrdinal}
                </span>
              )}
              <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-600">LIVE</span>
            </span>
          )}
          {isFinal && (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">FINAL</span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{game.awayTeam}</span>
            <span className="text-xs text-gray-500">
              {score?.scores?.find((s) => s.name === game.awayTeam)?.score ?? ""}
            </span>
          </div>
          <div className="text-right text-xs text-gray-500">
            {awayH2h && "ML " + formatOdds(awayH2h.price)}
            {awaySpread && " - " + (awaySpread.point! > 0 ? "+" : "") + awaySpread.point}
          </div>

          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{game.homeTeam}</span>
            <span className="text-xs text-gray-500">
              {score?.scores?.find((s) => s.name === game.homeTeam)?.score ?? ""}
            </span>
          </div>
          <div className="text-right text-xs text-gray-500">
            {homeH2h && "ML " + formatOdds(homeH2h.price)}
            {homeSpread && " - " + (homeSpread.point! > 0 ? "+" : "") + homeSpread.point}
          </div>
        </div>

        {over && (
          <div className="mt-2 text-xs text-gray-400">
            Total: O/U {over.point} ({formatOdds(over.price)})
          </div>
        )}
      </div>

      <div className="mt-4 rounded-card bg-white shadow-soft">
        <div className="border-b border-gray-100 px-5 py-3 text-sm font-medium text-gray-700">
          Your picks on this game
        </div>
        {matchedPicks.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-gray-400">No logged picks for this game.</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {matchedPicks.map((pick) => (
              <div key={pick.id} className="flex items-center justify-between px-5 py-3">
                <div>
                  <div className="text-sm font-medium">{pick.capper.name}</div>
                  <div className="mt-0.5 text-xs text-gray-500">
                    {pick.betDetail || betTypeLabel(pick.betType)} - {pick.odds > 0 ? "+" : ""}
                    {pick.odds} - {pick.units}u
                  </div>
                </div>
                <PickStatusButtons pickId={pick.id} status={pick.status} />
              </div>
            ))}
          </div>
        )}
      </div>

      {capperRecords.length > 0 && (
        <div className="mt-4 rounded-card bg-white shadow-soft">
          <div className="border-b border-gray-100 px-5 py-3 text-sm font-medium text-gray-700">
            Capper track record on this bet type
          </div>
          <div className="divide-y divide-gray-100">
            {capperRecords.map((r) => (
              <div
                key={r.capperId + r.betType + r.period}
                className="flex items-center justify-between px-5 py-3"
              >
                <div className="text-sm font-medium">{r.capperName}</div>
                <CapperScorecard buckets={r.buckets} variant="inline" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
