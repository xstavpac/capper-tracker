import type { BetType, Period, PropMarket } from "@prisma/client";
import { nrfiSide, parsePlayerProp } from "@/lib/bet-line";
import type { PickCategoryKey } from "@/server/data/stats";

// Extracted out of the Picks page (where this originated) so the capper
// comparison tool can reuse the exact same bet-type classification instead
// of a second, parallel scheme - both now import from here. Pure/client-safe
// (only type-only imports from @prisma/client and server/data/stats.ts -
// PickCategoryKey below is a type import too, fully erased at compile time -
// plus nrfiSide and parsePlayerProp from lib/bet-line.ts, both already
// client-safe) so it's importable from a "use client" component directly,
// unlike server/data/stats.ts's pickCategory (a DIFFERENT, MLB/F5-aware
// classification built for category breakdowns, not this flat cross-sport
// filter - the two are deliberately not unified, see betTypeFilterCategory's
// own comment in picks/page.tsx history for why). The chip-set gating
// functions below take an already-resolved PickCategoryKey[] rather than a
// sportName, so this file never needs to import chipSetForLeague itself (a
// runtime value import from stats.ts, which pulls in prisma) - the caller
// (picks/page.tsx, server-only) resolves the chip set and passes it in.

// PLAYER_PROP used to be one flat key covering every structured market
// (PropMarket enum: PASS_YDS/RUSH_YDS/REC_YDS/RECEPTIONS/TD) - split into the
// 5 concrete markets below so a capper can filter by the specific prop
// instead of only "Player Prop" as a whole. Deliberately NOT kept alongside
// the 5 as a 6th "any prop" option - if that's wanted later it should be a
// separate, explicitly-named concept, not a preserved ambiguous legacy key.
// RUSH_REC_YDS/PASS_RUSH_YDS (2026-09) extended this same split to the
// combined-category markets added alongside them in PropMarket - same
// structured-with-fallback resolution below, no new pattern needed.
export type BetTypeFilterKey =
  | "SPREAD"
  | "F5_SPREAD"
  | "MONEYLINE"
  | "F5_MONEYLINE"
  | "TOTAL"
  | "F5_TOTAL"
  | "TEAM_TOTAL"
  | "TD"
  | "PASS_YDS"
  | "RUSH_YDS"
  | "REC_YDS"
  | "RECEPTIONS"
  | "RUSH_REC_YDS"
  | "PASS_RUSH_YDS"
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
  { value: "TD", label: "Touchdown" },
  { value: "PASS_YDS", label: "Passing Yards" },
  { value: "RUSH_YDS", label: "Rushing Yards" },
  { value: "REC_YDS", label: "Receiving Yards" },
  { value: "RECEPTIONS", label: "Receptions" },
  { value: "RUSH_REC_YDS", label: "Rush + Rec Yards" },
  { value: "PASS_RUSH_YDS", label: "Pass + Rush Yards" },
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
export function betTypeFilterCategory(
  pick: { betType: BetType; period: Period; betDetail: string | null; propMarket: PropMarket | null }
): BetTypeFilterKey | null {
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
  if (pick.betType === "PLAYER_PROP") {
    // Same structured-with-fallback resolution as stats.ts's pickCategory and
    // grading.ts's resolvedPropMarket: propMarket, when set, is trusted
    // directly; when null (rows predating propMarket, or manually-entered
    // PLAYER_PROP picks that never ran through parsePlayerProp at import)
    // it's re-derived from betDetail via the same shared parser. Replicated
    // here rather than importing resolvedPropMarket directly since that
    // function lives in the server-only grading.ts and this file must stay
    // client-safe. A market that can't be resolved from either source
    // returns null, matching no filter key - same as any other unparseable
    // pick today.
    return pick.propMarket ?? parsePlayerProp(pick.betDetail ?? "")?.propMarket ?? null;
  }
  return null;
}

// Which of this file's filter keys are relevant to a given sport, expressed
// via that sport's chipSetForLeague(sportName) result (stats.ts) rather than
// the sport name itself - moved out of picks/page.tsx so this decision (and
// not just the classification above) is covered by a real, executable test;
// picks/page.tsx passes `null` for its own "no sport selected" case (every
// key is relevant then), and a real chip set otherwise.
//
// Two different sports' vocabulary for the same "first half of the game"
// period (schema.prisma's Period.FIRST_HALF comment: `"F5" in baseball
// terms, first half elsewhere`) - split into two lists so a label can be
// chosen per sport, not just a single yes/no "does this sport have
// first-half categories at all". MLB is the only chip set with the F5_*
// keys; NFL/NCAAF are the only chip sets with FIRST_HALF_ML/OVER/UNDER (see
// MLB_CHIP_SET/NFL_CHIP_SET's own comments in stats.ts) - KBO_CHIP_SET has
// neither, so KBO never reaches either branch and gets no F5/1H options at
// all, not "F5" by virtue of also being a baseball-family sport.
const F5_INNINGS_CATEGORY_KEYS: PickCategoryKey[] = ["F5_ML", "F5_SPREAD_MINUS", "F5_SPREAD_PLUS", "F5_OVER", "F5_UNDER"];
const FIRST_HALF_PERIOD_CATEGORY_KEYS: PickCategoryKey[] = ["FIRST_HALF_ML", "FIRST_HALF_OVER", "FIRST_HALF_UNDER"];
const FIRST_HALF_CATEGORY_KEYS: PickCategoryKey[] = [...F5_INNINGS_CATEGORY_KEYS, ...FIRST_HALF_PERIOD_CATEGORY_KEYS];
const FIRST_HALF_BET_TYPE_KEYS: BetTypeFilterKey[] = ["F5_SPREAD", "F5_MONEYLINE", "F5_TOTAL"];

// Spread/Moneyline/Total are unconditional since every chip set
// (MLB_CHIP_SET, NFL_CHIP_SET, DEFAULT_CHIP_SET, ...) includes their
// underlying FAV_ML/DOG_ML/SPREAD_MINUS/SPREAD_PLUS/OVER/UNDER categories.
// `chipSet === null` means "no sport selected" (the page's own "All sports"
// dropdown state) - every option is relevant then, not just the ones every
// chip set happens to share.
export function betTypeOptionsForChipSet(chipSet: PickCategoryKey[] | null): Set<BetTypeFilterKey> {
  const always: BetTypeFilterKey[] = ["SPREAD", "MONEYLINE", "TOTAL"];
  if (!chipSet) return new Set(BET_TYPE_FILTER_OPTIONS.map((o) => o.value));

  const has = (keys: PickCategoryKey[]) => keys.some((k) => chipSet.includes(k));

  const options = [...always];
  if (has(FIRST_HALF_CATEGORY_KEYS)) options.push("F5_SPREAD", "F5_MONEYLINE", "F5_TOTAL");
  if (chipSet.includes("TEAM_TOTAL")) options.push("TEAM_TOTAL");
  if (chipSet.includes("TD_PROP"))
    options.push("TD", "PASS_YDS", "RUSH_YDS", "REC_YDS", "RECEPTIONS", "RUSH_REC_YDS", "PASS_RUSH_YDS");
  if (has(["NRFI", "YRFI"])) options.push("NRFI", "YRFI");
  return new Set(options);
}

// "F5" (baseball's first-5-innings term) is only correct for MLB - a
// football sport's first-half picks share the same F5_SPREAD/F5_MONEYLINE/
// F5_TOTAL filter keys (see betTypeFilterCategory above, which buckets any
// sport's period===FIRST_HALF pick the same way) but must never be LABELED
// "F5" anywhere on the page. `chipSet === null` keeps the original "F5"
// label - that case isn't scoped to one sport's vocabulary, and every sport
// that actually has first-half data reaches this from MLB or NFL/NCAAF
// (never both at once), so there's no real ambiguity being papered over.
export function firstHalfLabelPrefixForChipSet(chipSet: PickCategoryKey[] | null): "F5" | "1H" {
  if (!chipSet) return "F5";
  return chipSet.some((k) => F5_INNINGS_CATEGORY_KEYS.includes(k)) ? "F5" : "1H";
}

// Combines betTypeOptionsForChipSet (which options are relevant) with
// firstHalfLabelPrefixForChipSet (what to call the first-half ones) into the
// final {value, label}[] a <select> renders for one sport.
export function visibleBetTypeOptionsForChipSet(chipSet: PickCategoryKey[] | null): { value: BetTypeFilterKey; label: string }[] {
  const relevant = betTypeOptionsForChipSet(chipSet);
  const prefix = firstHalfLabelPrefixForChipSet(chipSet);
  return BET_TYPE_FILTER_OPTIONS.filter((o) => relevant.has(o.value)).map((o) =>
    FIRST_HALF_BET_TYPE_KEYS.includes(o.value) ? { ...o, label: o.label.replace(/^F5\b/, prefix) } : o
  );
}
