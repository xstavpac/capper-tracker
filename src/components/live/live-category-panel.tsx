"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { CategoryBreakdownItem, LeagueRecordCard, PickCategoryKey } from "@/server/data/stats";
import { getLeagueRecordsAction } from "@/server/actions/picks";
import { CATEGORY_GRID, CategoryCard } from "@/components/dashboard/category-card";
import { PanelShell, TINTS } from "@/components/dashboard/panel-shell";
import { TargetIcon } from "@/components/dashboard/cappers-icons";
import { useSharedLiveScoresIfAny } from "@/components/live/use-live-scores";
import { easternDateKey } from "@/lib/dates";
import {
  LIVE_CATEGORY_REVEAL_STEP,
  buildCategoryTiles,
  drivingRecordText,
  formatPickOdds,
  rankCategoryPicks,
  revealState,
  slateCountText,
  slateListHeader,
  slatePicksByCategory,
  visibleGameIndexes,
  type LiveCategoryGame,
  type LiveCategoryPick,
} from "@/lib/live-category-picks";

type Records = Record<string, LeagueRecordCard | null>;

// /live's "record by category" panel: the league's markets as tinted CategoryCards in one white panel.
// Each card shows the market's all-time record and how many picks on the board right now are in it;
// opening one lists those picks, one line each, ordered by the track record of the capper behind each
// (lib/live-category-picks.ts). The pool is the board's own - same games, same scores, same poll - so
// a card's count is always the length of the list it opens.
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

  // A tile whose last pick left the board (its game went final) closes itself.
  const activeTile = tiles.find((t) => t.key === activeKey && t.slateCount > 0);
  const activePicks = activeTile ? (byCategory.get(activeTile.key) ?? []) : [];
  const ranked = records ? rankCategoryPicks(activePicks, sportLabel, records) : [];

  // One request for every tile's picks, on the first open. Every later open,
  // and every "Show more", is a slice of what is already here. It runs again
  // only if the open tile holds a pick the loaded records never asked about (a
  // pick imported since, arriving with a server refresh).
  const recordKey = (p: LiveCategoryPick) => p.capperId + "|" + sportLabel + "|" + p.category;
  const needsLoad = activeTile !== undefined && !failed && (records === null || activePicks.some((p) => records[recordKey(p)] === undefined));

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

  const reveal = revealState(requested, ranked.length);

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
            muted={tile.slateCount === 0}
            active={tile.key === activeTile?.key}
            onToggle={tile.slateCount > 0 ? () => toggle(tile.key) : undefined}
          />
        ))}
      </div>

      {activeTile && (
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
                {ranked.slice(0, reveal.shown).map(({ pick, record }, i) => {
                  const recordText = drivingRecordText(record, sportLabel, activeTile.label);
                  return (
                    <li key={pick.pickId} className="flex items-center gap-2 py-2 text-[13px] sm:gap-3">
                      <span className="w-5 shrink-0 text-right font-medium tabular-nums text-muted-foreground">{i + 1}</span>
                      <span title={pick.betDetail} className="min-w-0 flex-[1.4] truncate font-semibold text-foreground">
                        {pick.betDetail}
                      </span>
                      <span className="shrink-0 font-semibold tabular-nums text-foreground">{formatPickOdds(pick.odds)}</span>
                      <Link href={"/cappers/" + pick.capperId} title={pick.capperName} className="min-w-0 flex-1 truncate font-medium text-foreground hover:underline">
                        {pick.capperName}
                      </Link>
                      <span title={recordText} className="min-w-0 max-w-[38%] shrink truncate text-right font-medium tabular-nums text-[#5B6275] dark:text-muted-foreground">
                        {recordText}
                      </span>
                    </li>
                  );
                })}
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
