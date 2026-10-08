"use client";

import { useEffect, useMemo, useState } from "react";
import type { CategoryBreakdownItem, LeagueRecordCard, PickCategoryKey } from "@/server/data/stats";
import { getLeagueRecordsAction } from "@/server/actions/picks";
import { CATEGORY_GRID, CategoryCard } from "@/components/dashboard/category-card";
import { PanelShell, TINTS } from "@/components/dashboard/panel-shell";
import { TargetIcon } from "@/components/dashboard/cappers-icons";
import { useSharedLiveScoresIfAny } from "@/components/live/use-live-scores";
import { useLiveGameJump } from "@/components/live/live-game-jump";
import { easternDateKey } from "@/lib/dates";
import {
  LIVE_CATEGORY_REVEAL_STEP,
  buildCategoryTiles,
  categoryPickRows,
  rankCategoryPicks,
  revealState,
  slateCountText,
  slateEmptyText,
  slateListHeader,
  slatePicksByCategory,
  visibleGameIndexes,
  type LiveCategoryGame,
  type LiveCategoryPick,
} from "@/lib/live-category-picks";

type Records = Record<string, LeagueRecordCard | null>;

// /live's "record by category" panel: the league's markets as tinted CategoryCards in one white panel.
// Each card shows the market's all-time record and how many picks on the board right now are in it;
// opening one lists those picks, one line each (rank, pick, capper), ordered by the track record of the
// capper behind each (lib/live-category-picks.ts); a row takes the viewer to its game. A card with no
// picks on the board looks the same and opens to a single "No ... picks today" line. The pool is the
// board's own - same games, same scores, same poll - so a card's count is always the length of the
// list it opens.
export function LiveCategoryPanel({
  sportLabel,
  chipSet,
  items,
  games,
  picks,
}: {
  sportLabel: string;
  chipSet: { key: PickCategoryKey; label: string }[];
  items: CategoryBreakdownItem[];
  // Index-aligned with the board's game list; `picks[].gameIndex` points into it.
  games: LiveCategoryGame[];
  picks: LiveCategoryPick[];
}) {
  const scores = useSharedLiveScoresIfAny();
  const jumpToGame = useLiveGameJump();
  const [activeKey, setActiveKey] = useState<PickCategoryKey | null>(null);
  const [requested, setRequested] = useState(LIVE_CATEGORY_REVEAL_STEP);
  const [records, setRecords] = useState<Records | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // No shared scores means no board is mounted, so no card is showing a pick.
  const byCategory = useMemo(
    () => slatePicksByCategory(picks, scores ? visibleGameIndexes(games, scores, easternDateKey(new Date())) : new Set<number>()),
    [picks, games, scores]
  );
  const tiles = useMemo(
    () => buildCategoryTiles(chipSet, items, new Map(Array.from(byCategory, ([key, list]) => [key, list.length]))),
    [chipSet, items, byCategory]
  );

  // An open tile whose last pick leaves the board (its game went final) stays open, on the empty line.
  const activeTile = tiles.find((t) => t.key === activeKey);
  const activePicks = activeTile ? (byCategory.get(activeTile.key) ?? []) : [];
  const rows = records ? categoryPickRows(rankCategoryPicks(activePicks, sportLabel, records), games) : [];

  // One request for every tile's picks, on the first open of a tile that has any. Every later open,
  // and every "Show more", is a slice of what is already here. It runs again
  // only if the open tile holds a pick the loaded records never asked about (a
  // pick imported since, arriving with a server refresh).
  const recordKey = (p: LiveCategoryPick) => p.capperId + "|" + sportLabel + "|" + p.category;
  const needsLoad = activePicks.length > 0 && !failed && (records === null || activePicks.some((p) => records[recordKey(p)] === undefined));

  async function loadRecords() {
    setLoading(true);
    setFailed(false);
    try {
      const requestedKeys = new Set<string>();
      const entries: { capperId: string; leagueSport: string; category: PickCategoryKey }[] = [];
      for (const p of picks) {
        if (p.category === null || p.status === "CANCELLED" || requestedKeys.has(recordKey(p))) continue;
        requestedKeys.add(recordKey(p));
        entries.push({ capperId: p.capperId, leagueSport: sportLabel, category: p.category });
      }
      const loaded: Records = { ...(await getLeagueRecordsAction(entries)).records };
      // Anything asked for and not answered is "no record", never "ask again".
      for (const key of requestedKeys) if (loaded[key] === undefined) loaded[key] = null;
      setRecords(loaded);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (needsLoad && !loading) void loadRecords();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadRecords reads the current picks; needsLoad is the trigger
  }, [needsLoad, loading]);

  if (tiles.length === 0) return null;

  function toggle(key: PickCategoryKey) {
    setActiveKey((current) => (current === key ? null : key));
    setRequested(LIVE_CATEGORY_REVEAL_STEP);
    setFailed(false);
  }

  const reveal = revealState(requested, rows.length);

  return (
    <PanelShell
      theme={{ ...TINTS.neutral, title: sportLabel + " record by category", subtitle: "All-time, by market", icon: <TargetIcon className="h-[17px] w-[17px] stroke-[2.2]" /> }}
      footer={undefined}
    >
      <div className={CATEGORY_GRID}>
        {tiles.map((tile) => (
          <CategoryCard
            key={tile.key}
            label={tile.label}
            wins={tile.wins}
            losses={tile.losses}
            pushes={tile.pushes}
            winPct={tile.winPct}
            graded={tile.wins + tile.losses + tile.pushes}
            note={slateCountText(sportLabel, tile.slateCount)}
            tinted
            active={tile.key === activeTile?.key}
            onToggle={() => toggle(tile.key)}
          />
        ))}
      </div>

      {activeTile && activePicks.length === 0 && (
        <p className="mt-3 rounded-[14px] border border-[#E6E8EF] bg-[#FAFBFD] px-3.5 py-3 text-[13px] font-medium text-muted-foreground dark:border-border dark:bg-white/[0.03]">
          {slateEmptyText(sportLabel, activeTile.label)}
        </p>
      )}

      {activeTile && activePicks.length > 0 && (
        <div className="mt-3 rounded-[14px] border border-[#E6E8EF] bg-[#FAFBFD] px-3.5 py-3 dark:border-border dark:bg-white/[0.03]">
          <div className="mb-1 text-[13px] font-semibold text-[#5B6275] dark:text-muted-foreground">{slateListHeader(sportLabel, activeTile.label)}</div>
          {records === null ? (
            <p className="py-4 text-center text-[13px] font-medium text-muted-foreground">
              {failed ? (
                <>
                  Couldn&apos;t load records.{" "}
                  <button type="button" onClick={() => void loadRecords()} className="font-semibold text-foreground underline">
                    Try again
                  </button>
                </>
              ) : (
                "Loading picks…"
              )}
            </p>
          ) : (
            <>
              <ol className="divide-y divide-[#0F1420]/[0.06] dark:divide-white/10">
                {rows.slice(0, reveal.shown).map((row) => (
                  <li key={row.pickId}>
                    <button
                      type="button"
                      onClick={() => jumpToGame(row.gameId)}
                      className="-mx-2 flex min-h-[44px] w-[calc(100%+1rem)] cursor-pointer items-center gap-2 rounded-[9px] px-2 text-left text-[13px] transition-colors hover:bg-[#EEF1F7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 active:bg-[#E6E9F2] dark:hover:bg-white/[0.06] dark:active:bg-white/10 sm:min-h-[36px] sm:gap-3"
                    >
                      <span className="w-5 shrink-0 text-right font-medium tabular-nums text-muted-foreground">{row.rank}</span>
                      <span title={row.pick} className="min-w-0 flex-[1.4] truncate font-semibold text-foreground">
                        {row.pick}
                      </span>
                      <span title={row.capper} className="min-w-0 flex-1 truncate font-medium text-foreground">
                        {row.capper}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
              {reveal.more > 0 && (
                <div className="mt-2 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setRequested(reveal.shown + LIVE_CATEGORY_REVEAL_STEP)}
                    className="rounded-[9px] border border-[#E6E8EF] bg-white px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-[#F4F6FA] dark:border-border dark:bg-card dark:hover:bg-white/[0.06]"
                  >
                    Show {reveal.more} more
                  </button>
                  <span className="text-xs font-medium tabular-nums text-muted-foreground">{reveal.progress}</span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </PanelShell>
  );
}
