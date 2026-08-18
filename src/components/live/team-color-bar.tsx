// A thin solid-color bar in the team's real primary color, standing in for
// a logo image - see lib/team-colors.ts for why. Falls back to a neutral
// gray bar when the team isn't in getTeamColor's table (unmapped sport, or
// a nickname the table doesn't recognize yet) - still just a bar, never a
// badge, initials, or image. Renders only the bar itself (same contract the
// old TeamLogo had) - the caller supplies its own team-name text alongside it.
export function TeamColorBar({ color }: { color: string | null }) {
  return (
    <span
      className="h-4 w-1 shrink-0 rounded-sm"
      style={{ backgroundColor: color ?? "rgb(var(--muted-foreground))" }}
      aria-hidden="true"
    />
  );
}
