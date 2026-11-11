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

// ---------------------------------------------------------------------------
// Posted-odds capture - Pick.postedLine / oddsCapturedAt / oddsBook / oddsNullReason.
//
// Decided once, at insert, from the same facts resolvePickPrice used; stored with `odds` and `oddsSource` and
// written by nothing afterwards (posted-odds-write-once-guard-acceptance-test.ts). Point-in-time only: a price is
// never re-read from a later snapshot to fill a pick in.
//   STATED    - the capper's own price. oddsCapturedAt is our import time (the capper's own post time is not in
//               the pasted text); no book.
//   MARKET    - oddsCapturedAt is when the data that priced it was read (a fresh fetch's fetchedAt, or the snapshot
//               row's createdAt - the data is at least that new); oddsBook is the bookmaker for a game line.
//   DEFAULTED - the -110 placeholder is NOT a real price: no capture time, no book, and a reason.
// ---------------------------------------------------------------------------
// no_exact_line: an NBA prop whose player is listed in the event's prop market, but by no book at the pick's own
// number (nba-prop-odds.ts never prices off the nearest line).
export type OddsNullReason = "no_market" | "game_started" | "unsupported_prop" | "no_exact_line";

export type PostedOddsCapture = {
  postedLine: number | null;
  oddsCapturedAt: Date | null;
  oddsBook: string | null;
  oddsNullReason: OddsNullReason | null;
};

export function postedOddsCapture(args: {
  oddsSource: PickOddsSource;
  importedAt: Date;
  // The number stored on Pick.line. A feed price is only ever taken at this exact number, so it is the price's line too.
  line: number | null;
  // For MARKET: what the pricing data said about itself. capturedAt null = the data's own time was not readable.
  priced: { capturedAt: Date | null; book: string | null } | null;
  // For DEFAULTED: why nothing priced it.
  unpricedReason: OddsNullReason | null;
}): PostedOddsCapture {
  const { oddsSource, importedAt, line, priced, unpricedReason } = args;
  if (oddsSource === "STATED") return { postedLine: line, oddsCapturedAt: importedAt, oddsBook: null, oddsNullReason: null };
  if (oddsSource === "MARKET") return { postedLine: line, oddsCapturedAt: priced?.capturedAt ?? null, oddsBook: priced?.book ?? null, oddsNullReason: null };
  return { postedLine: line, oddsCapturedAt: null, oddsBook: null, oddsNullReason: unpricedReason ?? "no_market" };
}

// Why a DEFAULTED pick got no feed price, from what the import knows. A started game outranks the others: the
// feed's pregame listing no longer has it.
export function unpricedReasonFor(args: { betType: string; gameTime: Date; importedAt: Date }): OddsNullReason {
  if (args.gameTime.getTime() <= args.importedAt.getTime()) return "game_started";
  if (args.betType === "PLAYER_PROP") return "unsupported_prop";
  return "no_market";
}
