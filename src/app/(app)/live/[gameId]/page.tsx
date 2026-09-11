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
import { getGamePulsePanelRows } from "@/server/data/game-pulse";
import { getTeamRecordAsOf, type TeamRecord } from "@/server/data/team-record";
import { getMlbLiveGameState } from "@/server/data/live-game-state";
import { getNflLiveGameState } from "@/server/data/nfl-live-game-state";
import { formatEastern } from "@/lib/dates";
import { betTypeLabel, pickCategory } from "@/server/data/stats";
import { nrfiSide, formatPickLabel } from "@/lib/bet-line";
import { classifyPickTeamGroup, shortTeamName } from "@/lib/pick-team-group";
import { getTeamColor } from "@/lib/team-colors";
import { PickStatusButtons } from "@/components/dashboard/pick-status-buttons";
import { CapperScorecard } from "@/components/dashboard/capper-scorecard";
import { GamePulsePanel } from "@/components/live/game-pulse-panel";
import { GameMomentumPanel } from "@/components/live/game-momentum-panel";
import { NflGameMomentumPanel } from "@/components/live/nfl-game-momentum-panel";
import { GamePacePanel } from "@/components/live/game-pace-panel";
import { NflGamePacePanel } from "@/components/live/nfl-game-pace-panel";
import { GameHeadToHeadHeader, type HeadToHeadSide } from "@/components/live/game-head-to-head-header";
import { GamePicksExpander, type ExpanderPick } from "@/components/live/game-picks-expander";
import type { BetType, Period } from "@prisma/client";

function formatOdds(price: number) {
  return price > 0 ? "+" + price : String(price);
}

function findMarket(bookmaker: any, key: string) {
  return bookmaker?.markets?.find((m: any) => m.key === key);
}

// "82-64" / "82-64-1" (ties only shown when non-zero) - null when the team
// has no games in its record yet, so the header omits the line entirely
// instead of showing "0-0".
function formatRecordText(record: TeamRecord): string | null {
  if (record.gamesInRecord === 0) return null;
  return record.ties > 0 ? `${record.wins}-${record.losses}-${record.ties}` : `${record.wins}-${record.losses}`;
}

function ordinalSuffix(n: number): string {
  const j = n % 10;
  const k = n % 100;
  if (j === 1 && k !== 11) return n + "st";
  if (j === 2 && k !== 12) return n + "nd";
  if (j === 3 && k !== 13) return n + "rd";
  return n + "th";
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
        <div className="mt-4 rounded-card bg-card p-10 text-center shadow-soft">
          <p className="text-sm text-muted-foreground">Missing or unknown sport.</p>
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
        <div className="mt-4 rounded-card bg-card p-10 text-center shadow-soft">
          <p className="text-sm text-muted-foreground">
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

  // MLB and NFL both get the live Momentum gauge instead of Game Pulse
  // (Phase 1 investigation: Game Pulse does no live fetching at all, so it
  // couldn't be extended into this - Momentum needed its own per-game
  // live-state layer, see live-game-state.ts / nfl-live-game-state.ts).
  // Every other sport is unchanged and out of scope for this round.
  const isMlb = sportMeta.key === "baseball_mlb";
  const isNfl = sportMeta.key === "americanfootball_nfl";

  // Historical situational rates for both teams, independent of this game's
  // own live/final state - unlike the old tile badge this replaces (which
  // only ever evaluated a currently-live game's own innings), the panel
  // shows each team's track record regardless of whether this particular
  // game has started yet. Every other (non-MLB, non-NFL) sport falls
  // through to the MLB rate lookup, which harmlessly returns all-"not
  // enough data" rows for a non-MLB team name - unchanged from before this
  // sport branch existed. Skipped entirely for MLB/NFL, which no longer
  // render this panel.
  const pulseRows = isMlb || isNfl ? null : await getGamePulsePanelRows(game.homeTeam, game.awayTeam);

  // Head-to-head header data (MLB/NFL only - see the render below). Team
  // records reuse getTeamRecordAsOf exactly as it already exists elsewhere
  // (team-record.ts) - its day-before-this-game cutoff already means "this
  // team's record entering this game", which is exactly what a header needs,
  // so no new record reader was written for this. The live situation line
  // reuses the SAME cached live-state fetchers Momentum already polls
  // (getMlbLiveGameState / getNflLiveGameState) - this adds no new upstream
  // fetch, just one more (cached) reader of it for the header's SSR render.
  let awayRecordText: string | null = null;
  let homeRecordText: string | null = null;
  let situationText: string | null = null;

  if (isMlb || isNfl) {
    const gameDate = new Date(game.commenceTime);
    const [awayRecordAsOf, homeRecordAsOf] = await Promise.all([
      getTeamRecordAsOf(sportMeta.key, game.awayTeam, gameDate),
      getTeamRecordAsOf(sportMeta.key, game.homeTeam, gameDate),
    ]);
    awayRecordText = formatRecordText(awayRecordAsOf.record);
    homeRecordText = formatRecordText(homeRecordAsOf.record);

    if (isLive) {
      const liveId = score?.id ?? game.id;
      if (isMlb) {
        const state = await getMlbLiveGameState(liveId);
        const latest = state.plays[state.plays.length - 1];
        if (latest && score?.inningHalf && score?.inningOrdinal) {
          situationText = `${score.inningHalf} ${score.inningOrdinal} · ${latest.outs} out${latest.outs === 1 ? "" : "s"}`;
        }
      } else {
        const state = await getNflLiveGameState(liveId);
        if (state.situation?.down && state.situation.distance !== null) {
          situationText = `${ordinalSuffix(state.situation.down)} & ${state.situation.distance}`;
        }
      }
    }
  }

  const matchedPicks = await getPicksForGame(user.id, {
    sportName: sportMeta.label,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    commenceTime: new Date(game.commenceTime),
  });

  // MLB/NFL only - the richer picks-list component from the /live tab
  // (GamePicksExpander), reused directly rather than rebuilt. Mapping logic
  // here mirrors live/page.tsx's own expanderPicksByGame construction
  // exactly (classifyPickTeamGroup/shortTeamName/pickCategory/getTeamColor -
  // all pure, reused as-is), just applied to this one game's already-fetched
  // matchedPicks instead of a whole slate.
  const expanderPicks: ExpanderPick[] =
    isMlb || isNfl
      ? matchedPicks.map((p) => {
          const teamGroup = classifyPickTeamGroup(p, game, sportMeta.label);
          return {
            pickId: p.id,
            capperId: p.capperId,
            capperName: p.capper.name,
            capperColorTag: p.capper.colorTag,
            capperIsFavorite: p.capper.isFavorite,
            category: pickCategory({ ...p, sportName: sportMeta.label }),
            leagueName: sportMeta.label,
            betDetail: formatPickLabel(p.betDetail, p.betType, p.line) ?? betTypeLabel(p.betType),
            odds: p.odds,
            units: p.units,
            status: p.status,
            teamGroup,
            teamLabel:
              teamGroup === "AWAY"
                ? shortTeamName(game.awayTeam, sportMeta.label)
                : teamGroup === "HOME"
                  ? shortTeamName(game.homeTeam, sportMeta.label)
                  : "",
            teamColor:
              teamGroup === "AWAY"
                ? getTeamColor(sportMeta.key, game.awayTeam)
                : teamGroup === "HOME"
                  ? getTeamColor(sportMeta.key, game.homeTeam)
                  : null,
          };
        })
      : [];

  const recordKeys = new Map<
    string,
    { capperId: string; capperName: string; betType: BetType; period: Period; betDetail: string | null }
  >();
  for (const pick of matchedPicks) {
    // NRFI and YRFI share one betType, so the dedup key needs the resolved
    // side too - otherwise a capper's NRFI pick and YRFI pick on the same
    // game would collapse into one entry and only ever look up one bucket.
    const side = pick.betType === "NRFI" ? nrfiSide(pick.betDetail) : null;
    const key = pick.capperId + "|" + pick.betType + "|" + pick.period + "|" + (side ?? "");
    if (!recordKeys.has(key)) {
      recordKeys.set(key, {
        capperId: pick.capperId,
        capperName: pick.capper.name,
        betType: pick.betType,
        period: pick.period,
        betDetail: pick.betDetail,
      });
    }
  }

  const capperRecords = await Promise.all(
    Array.from(recordKeys.values()).map(async (entry) => ({
      ...entry,
      buckets: await getCapperScorecard(user.id, entry.capperId, {
        betType: entry.betType,
        period: entry.period,
        betDetail: entry.betDetail,
      }),
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
  const overText = over ? `O/U ${over.point} (${formatOdds(over.price)})` : null;
  const isPregame = !isLive && !isFinal;

  const awaySide: HeadToHeadSide = {
    fullName: game.awayTeam,
    shortName: shortTeamName(game.awayTeam, sportMeta.label),
    sportKey: sportMeta.key,
    recordText: awayRecordText,
    oddsText: awayH2h ? "ML " + formatOdds(awayH2h.price) + (awaySpread ? " · " + (awaySpread.point! > 0 ? "+" : "") + awaySpread.point : "") : null,
    score: score?.scores?.find((s) => s.name === game.awayTeam)?.score ?? null,
  };
  const homeSide: HeadToHeadSide = {
    fullName: game.homeTeam,
    shortName: shortTeamName(game.homeTeam, sportMeta.label),
    sportKey: sportMeta.key,
    recordText: homeRecordText,
    oddsText: homeH2h ? "ML " + formatOdds(homeH2h.price) + (homeSpread ? " · " + (homeSpread.point! > 0 ? "+" : "") + homeSpread.point : "") : null,
    score: score?.scores?.find((s) => s.name === game.homeTeam)?.score ?? null,
  };

  return (
    <div className="mx-auto max-w-2xl">
      <Link href={"/live?sport=" + sportMeta.key} className="text-sm text-brand-600">
        &larr; Back to Live
      </Link>

      <div className="mt-3 rounded-card bg-card p-5 shadow-soft">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {formatEastern(new Date(game.commenceTime), {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
            {book && " - " + book.title}
          </div>
          {isLive && (
            <span className="flex items-center gap-1.5">
              {/* MLB's inning/half badge moves into the head-to-head header's
                  own center block below (situationText) - suppressed here
                  only for MLB so it isn't shown twice. Harmless no-op for
                  every other sport: inningHalf/inningOrdinal only ever
                  populate for MLB (see odds.ts's ScoreGame comment). */}
              {!isMlb && score?.inningHalf && score?.inningOrdinal && (
                <span className="text-xs text-muted-foreground">
                  {score.inningHalf} {score.inningOrdinal}
                </span>
              )}
              <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-600 dark:bg-red-500/15 dark:text-red-400">LIVE</span>
            </span>
          )}
          {isFinal && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">FINAL</span>
          )}
        </div>

        {isMlb || isNfl ? (
          <GameHeadToHeadHeader away={awaySide} home={homeSide} situationText={situationText} overText={overText} isPregame={isPregame} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{game.awayTeam}</span>
                <span className="text-xs text-muted-foreground">
                  {score?.scores?.find((s) => s.name === game.awayTeam)?.score ?? ""}
                </span>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                {awayH2h && "ML " + formatOdds(awayH2h.price)}
                {awaySpread && " - " + (awaySpread.point! > 0 ? "+" : "") + awaySpread.point}
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{game.homeTeam}</span>
                <span className="text-xs text-muted-foreground">
                  {score?.scores?.find((s) => s.name === game.homeTeam)?.score ?? ""}
                </span>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                {homeH2h && "ML " + formatOdds(homeH2h.price)}
                {homeSpread && " - " + (homeSpread.point! > 0 ? "+" : "") + homeSpread.point}
              </div>
            </div>

            {over && (
              <div className="mt-2 text-xs text-muted-foreground">
                Total: O/U {over.point} ({formatOdds(over.price)})
              </div>
            )}
          </>
        )}
      </div>

      {isMlb ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <GameMomentumPanel
            gamePk={score?.id ?? game.id}
            homeTeam={game.homeTeam}
            awayTeam={game.awayTeam}
            gameDate={game.commenceTime}
            isLive={isLive}
            isFinal={isFinal}
          />
          <GamePacePanel
            gamePk={score?.id ?? game.id}
            homeTeam={game.homeTeam}
            awayTeam={game.awayTeam}
            gameDate={game.commenceTime}
            isLive={isLive}
            isFinal={isFinal}
          />
        </div>
      ) : isNfl ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <NflGameMomentumPanel
            eventId={score?.id ?? game.id}
            homeTeam={game.homeTeam}
            awayTeam={game.awayTeam}
            gameDate={game.commenceTime}
            isLive={isLive}
            isFinal={isFinal}
          />
          <NflGamePacePanel
            eventId={score?.id ?? game.id}
            homeTeam={game.homeTeam}
            awayTeam={game.awayTeam}
            gameDate={game.commenceTime}
            isLive={isLive}
            isFinal={isFinal}
          />
        </div>
      ) : (
        <GamePulsePanel rows={pulseRows!} homeTeam={game.homeTeam} awayTeam={game.awayTeam} sportLabel={sportMeta.label} />
      )}

      {isMlb || isNfl ? (
        // Same card shell (rounded-card bg-card shadow-soft p-4) the /live
        // tab already wraps this component in (live-scoreboard.tsx) - the
        // component itself supplies its own internal spacing (mt-3 on its
        // toggle button), so this wrapper only needs to match that card
        // treatment, not add any layout of its own. GamePicksExpander
        // itself renders null for zero picks (same as on /live) - guarded
        // here too, so an empty game never leaves a blank card shell behind.
        expanderPicks.length > 0 && (
          <div className="mt-4 rounded-card bg-card p-4 shadow-soft">
            <GamePicksExpander picks={expanderPicks} />
          </div>
        )
      ) : (
        <div className="mt-4 rounded-card bg-card shadow-soft">
          <div className="border-b border-border-subtle px-5 py-3 text-sm font-medium text-muted-foreground">
            Your picks on this game
          </div>
          {matchedPicks.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">No logged picks for this game.</p>
          ) : (
            <div className="divide-y divide-border-subtle">
              {matchedPicks.map((pick) => (
                <div key={pick.id} className="flex items-center justify-between px-5 py-3">
                  <div>
                    <div className="text-sm font-medium">{pick.capper.name}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {formatPickLabel(pick.betDetail, pick.betType, pick.line) ?? betTypeLabel(pick.betType)} -{" "}
                      {pick.odds > 0 ? "+" : ""}
                      {pick.odds} - {pick.units}u
                    </div>
                  </div>
                  <PickStatusButtons pickId={pick.id} status={pick.status} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {capperRecords.length > 0 && (
        <div className="mt-4 rounded-card bg-card shadow-soft">
          <div className="border-b border-border-subtle px-5 py-3 text-sm font-medium text-muted-foreground">
            Capper track record on this bet type
          </div>
          <div className="divide-y divide-border-subtle">
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
