"use client";

import { useEffect, useState, type Ref } from "react";
import { getLeagueRecordsAction } from "@/server/actions/picks";
import type { CapperLeagueRecords } from "@/server/data/picks";
import { PickCard } from "@/components/live/pick-card";
import { orderTeamSections, type GridLiveGamePanelData, type GridLiveTeamSideData } from "@/components/live/grid-live-team-panel-data";
import { LiveProgressBar } from "@/components/live/live-progress-bar";
import type { LiveGameProgress } from "@/lib/live-game-progress";

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
  headerRef,
}: GridLiveTeamSideData & { headerRef?: Ref<HTMLDivElement> }) {
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
    <div>
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
        className="mb-2 flex scroll-mt-4 items-center gap-1.5 rounded-md px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
        style={{
          // Same wash formula as GamePicksExpander's team-group header
          // (hex color + a ~12% alpha suffix) - reused as-is so the two
          // views' team-hue treatment matches exactly.
          backgroundColor: teamColor ? teamColor + "1F" : "rgb(var(--muted-foreground) / 0.10)",
        }}
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10 dark:ring-white/15"
          style={{ backgroundColor: teamColor ?? "rgb(var(--muted-foreground))" }}
          aria-hidden="true"
        />
        <span className="text-sm font-semibold text-foreground">{teamLabel}</span>
        <span className="text-xs text-muted-foreground">
          &mdash; {picks.length} pick{picks.length === 1 ? "" : "s"}
        </span>
      </div>

      {picks.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">No logged picks for {teamLabel}.</p>
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
  progress,
  firstHeaderRef,
}: {
  data: GridLiveGamePanelData;
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
    <div className="rounded-card bg-card p-4 shadow-soft">
      {progress && (
        <div className="mb-4">
          <LiveProgressBar pct={progress.pct} label={progress.label} />
        </div>
      )}
      <TeamPickSection {...first} headerRef={firstHeaderRef} />
      <div className="my-4 border-t border-border-subtle" />
      <TeamPickSection {...second} />
      <div className="my-4 border-t border-border-subtle" />
      {/* Totals, NRFI, player props, and any team-tied bet betDetail
          couldn't match to a side - same OTHER group GamePicksExpander shows
          under this label, now surfaced in Grid too. */}
      <TeamPickSection {...data.other} />
    </div>
  );
}
