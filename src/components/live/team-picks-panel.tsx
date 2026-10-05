"use client";

import { useEffect, useState, type Ref } from "react";
import { getLeagueRecordsAction } from "@/server/actions/picks";
import type { CapperLeagueRecords } from "@/server/data/picks";
import { PickCard } from "@/components/live/pick-card";
import { orderTeamSections, type GridLiveGamePanelData, type GridLiveTeamSideData } from "@/components/live/grid-live-team-panel-data";
import { LiveProgressBar } from "@/components/live/live-progress-bar";
import type { LiveGameProgress } from "@/lib/live-game-progress";
import { LocalGameTime } from "@/components/local-game-time";
import { TINTS } from "@/components/dashboard/panel-shell";

// Grid Live's fixed detail panel - shows BOTH teams' picks at once,
// stacked in one card, unlike GamePicksExpander (which lists AWAY/HOME/OTHER
// all at once when opened, but only for one game card at a time inline in
// the board). Deliberately not built on top of GamePicksExpander: that
// component's whole shape is "expand to reveal every group", the opposite of
// what a fixed side panel needs. It shares the pick-card itself with
// GamePicksExpander via the PickCard component (pick-card.tsx) rather than
// re-deriving any of that markup - a new, purpose-built layout around one
// shared card component, not a parallel calculation.
//
// A capper's category record is fetched here (not upstream) for the same
// reason GamePicksExpander defers it to expand-time: it requires each
// capper's full pick history and would be wasteful to compute for every game
// on the board just because Grid Live is open. Each team section fetches
// its own records independently, re-fetched whenever that team's pick set
// changes (a game switch) - see the useEffect key below.

// One team's section within the combined panel: header (color dot, name,
// pick count) plus its pick list or empty-state. Fetches its own capper
// records independently of the other team's section so one team's picks
// rendering isn't blocked on the other team's record fetch.
function TeamPickSection({
  teamLabel,
  teamColor,
  picks,
  tone,
  headerRef,
}: GridLiveTeamSideData & { headerRef?: Ref<HTMLDivElement> }) {
  const violet = tone === "violet";
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState<CapperLeagueRecords | null>(null);

  const picksKey = picks.map((p) => p.pickId).join(",");

  useEffect(() => {
    let cancelled = false;
    if (picks.length === 0) {
      setRecords(null);
      return;
    }
    setLoading(true);
    setRecords(null);
    const entries = picks.map((p) => ({ capperId: p.capperId, leagueSport: p.leagueName, category: p.category }));
    getLeagueRecordsAction(entries).then((result) => {
      if (cancelled) return;
      setRecords(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- picksKey stands in for picks (array identity changes every render otherwise)
  }, [picksKey]);

  return (
    // One tinted box per group: a wash of the team's color (same hex + low-alpha formula as
    // GamePicksExpander's team-group header), neutral gray for Totals or an unmapped team, violet for
    // Other markets. break-inside-avoid keeps a group whole in GameDetailPanel's column layout.
    <div
      className={
        "mb-3 break-inside-avoid rounded-[14px] border p-2.5 " +
        (violet ? TINTS.violet.card : teamColor ? "dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" : "border-[#E3E6EE] bg-[#F5F6FA] dark:border-border dark:bg-white/[0.04]")
      }
      style={!violet && teamColor ? { backgroundColor: teamColor + "14", borderColor: teamColor + "47" } : undefined}
    >
      <div
        ref={headerRef}
        // -1 so this is never in the tab sequence itself but IS a valid
        // target for the .focus() call GridLiveBoard's desktop auto-scroll
        // makes after scrolling the leading section's header into view
        // (only the leading section is ever passed a headerRef - see
        // GameDetailPanel below). outline-none + focus-visible: rather than
        // focus: means a mouse-click-triggered focus (the common case,
        // since selecting a game is a click) shows no ring, while a
        // keyboard-triggered selection still gets one.
        tabIndex={-1}
        className="mb-2 flex scroll-mt-4 items-center gap-2 rounded-md px-1 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      >
        <span
          className={
            "h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10 dark:ring-white/15" +
            (violet ? " bg-violet-500 dark:bg-violet-400" : "")
          }
          style={violet ? undefined : { backgroundColor: teamColor ?? "rgb(var(--muted-foreground))" }}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{teamLabel}</span>
        <span className="shrink-0 text-xs font-medium text-[#5B6275] dark:text-muted-foreground">
          {picks.length} pick{picks.length === 1 ? "" : "s"}
        </span>
      </div>

      {picks.length === 0 ? (
        <p className="py-4 text-center text-[13px] font-medium text-muted-foreground">No logged picks for {teamLabel}.</p>
      ) : (
        <div className="space-y-1.5">
          {picks.map((pick) => (
            <PickCard key={pick.pickId} pick={pick} records={records} loading={loading} selectable />
          ))}
        </div>
      )}
    </div>
  );
}

// `progress` is this panel's own copy of the selected game's live-progress
// read (see lib/live-game-progress.ts) - null whenever the game isn't live
// or the sport/state isn't covered yet, in which case nothing renders here.
// This is the ONLY place mobile ever shows live progress - GridLiveGameList
// deliberately withholds it from the collapsed list rows below `lg:` (see
// that file), so on mobile this panel (which only appears once a game is
// tapped - the "clicked/expanded state") is where it has to live.
export function GameDetailPanel({
  data,
  commenceTime,
  pickCount,
  progress,
  firstHeaderRef,
}: {
  data: GridLiveGamePanelData;
  // The selected game's start and its total matched picks (every group), for the panel's header -
  // both read from what GridLiveBoard already holds for the game list.
  commenceTime: string;
  pickCount: number;
  progress?: LiveGameProgress | null;
  // Desktop's auto-scroll-to-picks target (see grid-live-board.tsx) - the
  // leading team section's header, whichever team that is per
  // orderTeamSections, since that's the first thing under the progress bar a
  // clicked-in-from-far-down-the-list user should land on. Only wired up on
  // desktop; mobile already has its own scroll-to-panel behavior and doesn't
  // pass this.
  firstHeaderRef?: Ref<HTMLDivElement>;
}) {
  const [first, second] = orderTeamSections(data.away, data.home);
  return (
    <section className={"rounded-[18px] border p-3.5 " + TINTS.neutral.card}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">
          {data.away.teamLabel} @ {data.home.teamLabel}
        </h2>
        <p className="flex shrink-0 items-center gap-2 text-xs font-medium text-[#5B6275] dark:text-muted-foreground">
          <LocalGameTime date={commenceTime} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
          <span className="rounded-full bg-[#E6ECFF] px-2 py-0.5 text-[10.5px] font-semibold leading-none text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
            {pickCount} pick{pickCount === 1 ? "" : "s"}
          </span>
        </p>
      </div>
      {progress && <LiveProgressBar pct={progress.pct} label={progress.label} />}
      {/* The groups, in the same order as before (leading team, other team, then Totals and Other
          markets - the same TOTALS and OTHER groups GamePicksExpander shows, each hidden when empty),
          flowed into balanced columns: two when the panel has room for two ~230px columns, else one.
          -mb-3 takes back the last group's own bottom margin. */}
      <div className="-mb-3 mt-3 gap-3 [columns:230px_2]">
        <TeamPickSection {...first} headerRef={firstHeaderRef} />
        <TeamPickSection {...second} />
        {data.totals.picks.length > 0 && <TeamPickSection {...data.totals} />}
        {data.other.picks.length > 0 && <TeamPickSection {...data.other} />}
      </div>
    </section>
  );
}
