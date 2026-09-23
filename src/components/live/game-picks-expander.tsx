"use client";

import { useState } from "react";
import type { PickStatus } from "@prisma/client";
import { getLeagueRecordsAction } from "@/server/actions/picks";
import type { PickCategoryKey } from "@/server/data/stats";
import type { CapperLeagueRecords } from "@/server/data/picks";
import { OTHER_GROUP_LABEL } from "@/lib/pick-team-group";
import { PickCard } from "@/components/live/pick-card";

export type ExpanderPick = {
  pickId: string;
  capperId: string;
  capperName: string;
  capperColorTag: string | null;
  capperIsFavorite: boolean;
  category: PickCategoryKey | null;
  // The game's league (sport name, e.g. "NCAAF") - names row 2 of the record
  // block ("55% (11-9) in NCAAF"). One per /live page tab.
  leagueName: string;
  // The game this pick belongs to (see live-board-picks.ts) - unused by this
  // component itself, but the Parlay Pool needs both to group/scope a pooled
  // pick by league and to label which matchup it came from, without a second
  // lookup back to the odds board.
  gameId: string;
  gameLabel: string;
  betDetail: string;
  odds: number;
  units: number;
  status: PickStatus;
  // Raw classification fields (Section 4 - src/lib/parlay/relationship-
  // classifier.ts), separate from the display-formatted betDetail above:
  // Build My Picks' conflict validation needs the pick's own betType/period/
  // line/betDetail plus its game's homeTeam/awayTeam/gameTime to call
  // describePick/classifyPair the same way the acceptance harness does.
  // gameTime is an ISO string (not a Date) so ExpanderPick stays a plain,
  // JSON-serializable object crossing the server/client boundary.
  betType: string;
  period: string;
  rawBetDetail: string | null;
  line: number | null;
  homeTeam: string;
  awayTeam: string;
  gameTime: string;
  // Which side of the matchup this pick is tied to, precomputed server-side
  // (see live/page.tsx) since classifying it needs the game's homeTeam/
  // awayTeam alongside betDetail. teamLabel is the short display name for
  // AWAY/HOME ("Pirates") - empty for OTHER, which always uses a fixed
  // "Totals & other markets" header instead.
  teamGroup: "AWAY" | "HOME" | "OTHER";
  teamLabel: string;
  // The team's real primary brand color (getTeamColor, computed server-side in
  // live/page.tsx from the game's sport key + full team name) for this group's
  // header dot. null for OTHER, and for any team getTeamColor can't map yet -
  // both render the neutral-gray fallback dot, no special-casing needed.
  teamColor: string | null;
};

// Fixed AWAY -> HOME -> OTHER ordering (matches how the game card itself
// always lists away over home) - "OTHER" reuses the same three-group shape
// with a static label instead of a per-game team name.
const TEAM_GROUP_ORDER: ExpanderPick["teamGroup"][] = ["AWAY", "HOME", "OTHER"];

function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0" aria-hidden="true">
      <path d="M3.5 5.5l1.3 1.3l2.2 -2.3" />
      <path d="M3.5 12.5l1.3 1.3l2.2 -2.3" />
      <path d="M3.5 19.5l1.3 1.3l2.2 -2.3" />
      <path d="M11 6h9.5" />
      <path d="M11 13h9.5" />
      <path d="M11 20h9.5" />
    </svg>
  );
}

export function ChevronIcon({ up }: { up: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={"h-4 w-4 shrink-0 transition-transform " + (up ? "rotate-180" : "")}
      aria-hidden="true"
    >
      <path d="M6 9l6 6l6 -6" />
    </svg>
  );
}

export function GamePicksExpander({ picks }: { picks: ExpanderPick[] }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<CapperLeagueRecords | null>(null);

  if (picks.length === 0) return null;

  async function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const next = !open;
    setOpen(next);

    if (next && data === null) {
      setLoading(true);
      // Every pick, category or not - a null-category pick still contributes
      // its capper to the overall-streak map (the indicator shows on every
      // card), it just gets no record card back.
      const entries = picks.map((p) => ({
        capperId: p.capperId,
        leagueSport: p.leagueName,
        category: p.category,
      }));
      const result = await getLeagueRecordsAction(entries);
      setData(result);
      setLoading(false);
    }
  }

  function renderPickCard(p: ExpanderPick) {
    return <PickCard key={p.pickId} pick={p} records={data} loading={loading} selectable />;
  }

  const groups = TEAM_GROUP_ORDER.map((teamGroup) => {
    const groupPicks = picks.filter((p) => p.teamGroup === teamGroup);
    const label = teamGroup === "OTHER" ? OTHER_GROUP_LABEL : groupPicks[0]?.teamLabel;
    // Drives both the header dot and the row's background tint. OTHER isn't a
    // real team - always neutral gray. A real team uses its brand color,
    // falling back to the same gray when unmapped.
    const dotColor = teamGroup === "OTHER" ? null : groupPicks[0]?.teamColor ?? null;
    return { teamGroup, label, dotColor, picks: groupPicks };
  }).filter((g) => g.picks.length > 0);

  return (
    <div onClick={(e) => e.preventDefault()}>
      <button
        onClick={toggle}
        className="mt-3 flex w-full items-center gap-2 rounded-lg bg-brand-50 px-3 py-2.5 text-sm font-medium text-brand-700 transition hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:hover:bg-brand-500/20"
      >
        <ListIcon />
        <span className="flex-1 text-left">
          {picks.length} pick{picks.length === 1 ? "" : "s"} on this game
        </span>
        <ChevronIcon up={open} />
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {groups.map((group) => (
            <div key={group.teamGroup}>
              <div
                className="mb-1.5 flex items-center gap-1.5 rounded-md px-2 py-1"
                style={{
                  // A subtle wash of the team's color across the whole header
                  // row - the hex plus a low-alpha suffix (~12%). OTHER and any
                  // unmapped team use the same faint neutral-gray tint.
                  backgroundColor: group.dotColor
                    ? group.dotColor + "1F"
                    : "rgb(var(--muted-foreground) / 0.10)",
                }}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full ring-1 ring-inset ring-black/10 dark:ring-white/15"
                  style={{ backgroundColor: group.dotColor ?? "rgb(var(--muted-foreground))" }}
                  aria-hidden="true"
                />
                <span className="text-[12px] font-semibold text-foreground">{group.label}</span>
                <span className="text-[11px] text-muted-foreground">
                  &mdash; {group.picks.length} pick{group.picks.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="space-y-1.5">{group.picks.map((p) => renderPickCard(p))}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
