import Link from "next/link";
import { getOddsForSport, getLiveScoresForSport, matchScoreToGame, LIVE_SPORTS } from "@/server/data/odds";
import { sameLocalDay } from "@/lib/dates";

function formatOdds(price: number) {
  return price > 0 ? "+" + price : String(price);
}

function findMarket(bookmaker: any, key: string) {
  return bookmaker?.markets?.find((m: any) => m.key === key);
}

function tabClass(isActive: boolean) {
  return (
    "rounded-full px-4 py-1.5 text-sm font-medium " +
    (isActive ? "bg-red-600 text-white" : "bg-white text-gray-600 shadow-soft hover:bg-gray-50")
  );
}

export default async function LivePage({
  searchParams,
}: {
  searchParams: { sport?: string };
}) {
  const activeSport = searchParams.sport || LIVE_SPORTS[0].key;

  const [allOdds, scores] = await Promise.all([getOddsForSport(activeSport), getLiveScoresForSport(activeSport)]);

  // The once-daily odds cache is keyed by UTC calendar day, but MLB's evening
  // games straddle that boundary - the day's first fetch can land after some
  // of the previous day's late games already started, permanently pulling
  // them into "today's" snapshot. Drop anything from a strictly earlier local
  // calendar day here rather than changing what gets cached (bulk-import's
  // odds lookup still needs to find those games by team name regardless).
  const now = new Date();
  const odds = allOdds.filter((game) => {
    const gameDate = new Date(game.commenceTime);
    return sameLocalDay(gameDate, now) || gameDate > now;
  });

  const hasApiKey = process.env.ODDS_API_KEY ? true : false;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Live odds and scores</h1>
        <p className="mt-1 text-sm text-gray-500">Powered by The Odds API</p>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {LIVE_SPORTS.map((s) => (
          <a key={s.key} href={"/live?sport=" + s.key} className={tabClass(activeSport === s.key)}>{s.label}</a>
        ))}
      </div>

      {!hasApiKey && (
        <div className="rounded-card bg-white p-6 text-center text-sm text-gray-500 shadow-soft">
          No ODDS_API_KEY configured yet.
        </div>
      )}

      {hasApiKey && odds.length === 0 && (
        <div className="rounded-card bg-white p-10 text-center shadow-soft">
          <p className="text-sm text-gray-400">No games found for this sport right now.</p>
        </div>
      )}

      <div className="space-y-3">
        {odds.map((game) => {
          const score = matchScoreToGame(scores, game);
          const book = game.bookmakers[0];
          function findMarketAcrossBooks(key: string) {
            for (const b of game.bookmakers) {
              const m = findMarket(b, key);
              if (m) return m;
            }
            return undefined;
          }
          const h2h = findMarketAcrossBooks("h2h");
          const spreads = findMarketAcrossBooks("spreads");
          const totals = findMarketAcrossBooks("totals");

          const homeH2h = h2h?.outcomes.find((o: any) => o.name === game.homeTeam);
          const awayH2h = h2h?.outcomes.find((o: any) => o.name === game.awayTeam);
          const homeSpread = spreads?.outcomes.find((o: any) => o.name === game.homeTeam);
          const awaySpread = spreads?.outcomes.find((o: any) => o.name === game.awayTeam);
          const over = totals?.outcomes.find((o: any) => o.name === "Over");

          const isLive = score?.status === "live";
          const isFinal = score?.status === "final";

          return (
            <Link
              key={game.id}
              href={"/live/" + game.id + "?sport=" + activeSport}
              className="block rounded-card bg-white p-4 shadow-soft transition-shadow hover:shadow-md"
            >
              <div className="mb-2 flex items-center justify-between">
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
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-600">
                    LIVE
                  </span>
                )}
                {isFinal && (
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                    FINAL
                  </span>
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
            </Link>
          );
        })}
      </div>
    </div>
  );
}

