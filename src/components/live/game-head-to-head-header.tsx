import { getTeamColor } from "@/lib/team-colors";

// Head-to-head redesign of the game-detail header for MLB/NFL only (see
// live/[gameId]/page.tsx - every other sport keeps the original stacked
// team-row header, untouched). Server-renderable: no client state, no
// polling - the same "static per page load" behavior the header already
// had, just laid out horizontally with team identity/record on the sides
// and the live situation/score/total centered between them.
//
// No logo/crest images: this app deliberately doesn't render team logo
// marks (see team-colors.ts's own header - the real logo images were pulled
// from ESPN's CDN without licensing rights and removed). The "crest" here is
// a colored badge using the team's own verified brand color plus its
// initials, the same colored-circle-with-initials convention Avatar
// (capper-panels.tsx) already establishes for cappers.

function initials(shortName: string): string {
  return shortName.slice(0, 2).toUpperCase();
}

function TeamCrest({ shortName, color, size = 40 }: { shortName: string; color: string | null; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
      style={{ backgroundColor: color ?? "rgb(var(--muted-foreground))", width: size, height: size }}
      aria-hidden="true"
    >
      {initials(shortName)}
    </div>
  );
}

export type HeadToHeadSide = {
  fullName: string;
  shortName: string;
  sportKey: string;
  // "82-64" / "82-64-1" (ties only shown when non-zero) - null when the team
  // has no games in its record yet.
  recordText: string | null;
  // "ML -150 · -1.5" - null when neither market has a line for this side.
  oddsText: string | null;
  // Formatted score string ("4"), null pregame (nothing to show yet).
  score: string | null;
};

function TeamBlock({ side, align }: { side: HeadToHeadSide; align: "left" | "right" }) {
  const color = getTeamColor(side.sportKey, side.fullName);
  const crest = <TeamCrest shortName={side.shortName} color={color} />;
  const text = (
    <div className={"min-w-0 " + (align === "right" ? "text-right" : "")}>
      <div className="truncate text-sm font-semibold text-foreground">{side.shortName}</div>
      {side.recordText && <div className="text-xs text-muted-foreground">{side.recordText}</div>}
      {side.oddsText && <div className="text-xs text-muted-foreground">{side.oddsText}</div>}
    </div>
  );
  return (
    <div className={"flex min-w-0 flex-1 items-center gap-2.5 " + (align === "right" ? "flex-row-reverse" : "")}>
      {crest}
      {text}
    </div>
  );
}

export function GameHeadToHeadHeader({
  away,
  home,
  situationText,
  overText,
  isPregame,
}: {
  away: HeadToHeadSide;
  home: HeadToHeadSide;
  situationText: string | null;
  overText: string | null;
  isPregame: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <TeamBlock side={away} align="left" />

      <div className="flex shrink-0 flex-col items-center gap-0.5 px-2">
        {situationText && <div className="text-[11px] font-medium text-muted-foreground">{situationText}</div>}
        <div className="text-2xl font-bold tabular-nums text-foreground">
          {isPregame ? "@" : `${away.score ?? "0"} – ${home.score ?? "0"}`}
        </div>
        {overText && <div className="text-xs text-muted-foreground">{overText}</div>}
      </div>

      <TeamBlock side={home} align="right" />
    </div>
  );
}
