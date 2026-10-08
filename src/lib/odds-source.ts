// Where a pick's stored price came from - Pick.oddsSource (schema.prisma).
//
// The importer has always stored -110 for a line with no price, and nothing
// marked which -110s were real. This is that mark, decided once at write time:
//   STATED    - the capper's own price (typed on the line, or the manual form)
//   MARKET    - no price on the line; the odds feed supplied one
//   DEFAULTED - no price on the line and none from the feed: the -110 placeholder
//
// Pure, and the ONLY place the three-way decision is made: the bulk-import
// resolver hands it the line's own price info plus whatever the feed returned,
// and stores the odds and the source it gets back together, so the two can't
// disagree. Lines recovered by recover-unresolved-lines.ts carry the same
// `odds` / `hasExplicitOdds` pair and are imported through that same resolver.
export type PickOddsSource = "STATED" | "MARKET" | "DEFAULTED";

export function resolvePickPrice(
  line: { odds: number; hasExplicitOdds: boolean },
  feedPrice: number | null
): { odds: number; oddsSource: PickOddsSource } {
  if (line.hasExplicitOdds) return { odds: line.odds, oddsSource: "STATED" };
  if (feedPrice !== null) return { odds: feedPrice, oddsSource: "MARKET" };
  return { odds: line.odds, oddsSource: "DEFAULTED" };
}
