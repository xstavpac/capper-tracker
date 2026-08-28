import type { BetType, Period } from "@prisma/client";
import { nrfiSide } from "@/lib/bet-line";

// Extracted out of the Picks page (where this originated) so the capper
// comparison tool can reuse the exact same bet-type classification instead
// of a second, parallel scheme - both now import from here. Pure/client-safe
// (only type-only imports from @prisma/client, which are fully erased at
// compile time, plus nrfiSide from lib/bet-line.ts, itself already
// client-safe) so it's importable from a "use client" component directly,
// unlike server/data/stats.ts's pickCategory (a DIFFERENT, MLB/F5-aware
// classification built for category breakdowns, not this flat cross-sport
// filter - the two are deliberately not unified, see betTypeFilterCategory's
// own comment in picks/page.tsx history for why).
export type BetTypeFilterKey =
  | "SPREAD"
  | "F5_SPREAD"
  | "MONEYLINE"
  | "F5_MONEYLINE"
  | "TOTAL"
  | "F5_TOTAL"
  | "TEAM_TOTAL"
  | "PLAYER_PROP"
  | "NRFI"
  | "YRFI";

export const BET_TYPE_FILTER_OPTIONS: { value: BetTypeFilterKey; label: string }[] = [
  { value: "SPREAD", label: "Spread" },
  { value: "F5_SPREAD", label: "F5 Spread" },
  { value: "MONEYLINE", label: "Moneyline" },
  { value: "F5_MONEYLINE", label: "F5 Moneyline" },
  { value: "TOTAL", label: "Total" },
  { value: "F5_TOTAL", label: "F5 Total" },
  { value: "TEAM_TOTAL", label: "Team Total" },
  { value: "PLAYER_PROP", label: "Player Prop" },
  { value: "NRFI", label: "NRFI" },
  { value: "YRFI", label: "YRFI" },
];

// A flat "what kind of bet is this" classification over every sport's
// picks, deliberately coarser and sport-agnostic than stats.ts's
// pickCategory (see that function's own comment) - this is what powers
// the Picks page's bet-type filter dropdown and now the capper comparison
// tool's filter bar identically. Reuses nrfiSide (the same betDetail-derived
// NRFI/YRFI split stats.ts and grading.ts use) so this filter can never
// disagree with how those picks actually graded.
export function betTypeFilterCategory(pick: { betType: BetType; period: Period; betDetail: string | null }): BetTypeFilterKey | null {
  if (pick.betType === "NRFI") {
    return nrfiSide(pick.betDetail) === "YES_RUN" ? "YRFI" : "NRFI";
  }
  // TEAM_TOTAL is period-independent, same as stats.ts's pickCategory - one
  // filter option regardless of full game/F5/1st half, unlike TOTAL above
  // which splits by period. Checked before the FIRST_HALF branch so a
  // first-half team total doesn't fall into F5_TOTAL/get dropped instead.
  if (pick.betType === "TEAM_TOTAL") return "TEAM_TOTAL";
  if (pick.period === "FIRST_HALF") {
    if (pick.betType === "MONEYLINE") return "F5_MONEYLINE";
    if (pick.betType === "SPREAD") return "F5_SPREAD";
    if (pick.betType === "TOTAL") return "F5_TOTAL";
    return null;
  }
  if (pick.betType === "SPREAD") return "SPREAD";
  if (pick.betType === "MONEYLINE") return "MONEYLINE";
  if (pick.betType === "TOTAL") return "TOTAL";
  if (pick.betType === "PLAYER_PROP") return "PLAYER_PROP";
  return null;
}
