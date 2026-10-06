import type { CSSProperties } from "react";

// One color per league, for the small league marks (filter dots, pick badges): a light-theme hex
// and its dark-theme counterpart. Per-team colors are in team-colors.ts.
export type LeagueColor = { light: string; dark: string };

export const LEAGUE_COLORS: Record<string, LeagueColor> = {
  NFL: { light: "#1D4ED8", dark: "#60A5FA" },
  NCAAF: { light: "#B45309", dark: "#FBBF24" },
  MLB: { light: "#DC2626", dark: "#F87171" },
  NHL: { light: "#0E7490", dark: "#22D3EE" },
  NBA: { light: "#EA580C", dark: "#FB923C" },
  WNBA: { light: "#BE185D", dark: "#F472B6" },
  NCAAB: { light: "#6D28D9", dark: "#A78BFA" },
};

const OTHER_LEAGUE_COLOR: LeagueColor = { light: "#475569", dark: "#94A3B8" };

export function leagueColor(sportName: string): LeagueColor {
  return LEAGUE_COLORS[sportName.toUpperCase()] ?? OTHER_LEAGUE_COLOR;
}

// Both hexes as CSS variables, so a class picks the theme's one: `bg-[var(--league)] dark:bg-[var(--league-dark)]`.
export function leagueColorVars(sportName: string): CSSProperties {
  const c = leagueColor(sportName);
  return { "--league": c.light, "--league-dark": c.dark } as CSSProperties;
}
