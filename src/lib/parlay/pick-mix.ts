// Auto-Generate's "Include Picks" filter (All / Game Lines / Props) and its
// Pick Mix (how many legs come from game lines vs props when All is on). The
// labels and the split arithmetic live here so the controls and the generator
// can't disagree. Pure and client-safe.
import { classifyPickKind, type PickKind } from "@/lib/parlay/pick-kind";

export type IncludePicks = "ALL" | "GAME_LINES" | "PROPS";

export const INCLUDE_PICKS_OPTIONS: { key: IncludePicks; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "GAME_LINES", label: "Game Lines" },
  { key: "PROPS", label: "Props" },
];

export function toIncludePicks(value: unknown): IncludePicks {
  return value === "GAME_LINES" || value === "PROPS" ? value : "ALL";
}

// Which kind of pick a filter keeps. null keeps both.
export function includedKind(include: IncludePicks): PickKind | null {
  return include === "GAME_LINES" ? "GAME_LINE" : include === "PROPS" ? "PROP" : null;
}

export function keepsPick(include: IncludePicks, pick: Parameters<typeof classifyPickKind>[0]): boolean {
  const kind = includedKind(include);
  return kind === null || classifyPickKind(pick) === kind;
}

// The mix is the Game Lines share, a whole percentage in steps of 10. Props
// get the rest.
export const PICK_MIX_STEP = 10;
export const PICK_MIX_PRESETS = [100, 80, 60, 50, 30, 0] as const;

// Anything that isn't a whole step from 0 to 100 is no mix at all.
export function toGameLinesPct(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 0 || value > 100 || value % PICK_MIX_STEP !== 0) return null;
  return value;
}

export type MixSplit = { gameLines: number; props: number };

// Game Lines legs = round(legs x GL%), Props gets the remainder. Integer math
// first, so 7 x 30% is exactly 210/100 = 2.1 and never 2.0999...
export function mixSplit(legs: number, gameLinesPct: number): MixSplit {
  const gameLines = Math.round((legs * gameLinesPct) / 100);
  return { gameLines, props: legs - gameLines };
}

// "60 / 40"
export function mixLabel(gameLinesPct: number): string {
  return `${gameLinesPct} / ${100 - gameLinesPct}`;
}

// "60 / 40 → 4 Game Lines · 3 Props"
export function mixSplitText(legs: number, gameLinesPct: number): string {
  const { gameLines, props } = mixSplit(legs, gameLinesPct);
  return `${mixLabel(gameLinesPct)} → ${gameLines} Game Line${gameLines === 1 ? "" : "s"} · ${props} Prop${props === 1 ? "" : "s"}`;
}
