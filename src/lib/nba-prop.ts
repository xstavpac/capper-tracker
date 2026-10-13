// NBA player-prop markets - the NBA twin of nhl-prop.ts / mlb-prop.ts. Only the
// market list lives here so far (2026-10, alongside the schema values): there
// is no NBA parser yet, so nothing produces one of these from pick text and
// NBA prop lines are still rejected at import (unsupported-prop-vocab.ts).
//
// Markets (mirror the NBA values of schema.prisma's PropMarket enum):
//   POINTS                    over/under - SHARED with the NHL (nhl-prop.ts)
//   ASSISTS                   over/under - SHARED with the NHL
//   REBOUNDS                  over/under
//   THREES_MADE               over/under (three-pointers made)
//   STEALS                    over/under
//   BLOCKS                    over/under
//   POINTS_REBOUNDS_ASSISTS   over/under on the sum ("PRA")
//   POINTS_REBOUNDS           over/under on the sum
//   POINTS_ASSISTS            over/under on the sum
//   REBOUNDS_ASSISTS          over/under on the sum
//   DOUBLE_DOUBLE             yes/no (no line)
//
// POINTS and ASSISTS are one enum value for both leagues: the value names the
// stat, the pick's sport says whose. Anything that reads either value must
// know the sport too - isNbaPropMarket("POINTS") and isNhlPropMarket("POINTS")
// are both true.

export type NbaPropMarket =
  | "POINTS"
  | "ASSISTS"
  | "REBOUNDS"
  | "THREES_MADE"
  | "STEALS"
  | "BLOCKS"
  | "POINTS_REBOUNDS_ASSISTS"
  | "POINTS_REBOUNDS"
  | "POINTS_ASSISTS"
  | "REBOUNDS_ASSISTS"
  | "DOUBLE_DOUBLE";

export const NBA_PROP_MARKETS: readonly NbaPropMarket[] = [
  "POINTS",
  "ASSISTS",
  "REBOUNDS",
  "THREES_MADE",
  "STEALS",
  "BLOCKS",
  "POINTS_REBOUNDS_ASSISTS",
  "POINTS_REBOUNDS",
  "POINTS_ASSISTS",
  "REBOUNDS_ASSISTS",
  "DOUBLE_DOUBLE",
];

// The values no other sport has. A pick carrying one of these is an NBA prop
// whatever else is known about it; POINTS / ASSISTS need the sport.
export const NBA_ONLY_PROP_MARKETS: readonly NbaPropMarket[] = NBA_PROP_MARKETS.filter((m) => m !== "POINTS" && m !== "ASSISTS");

export function isNbaPropMarket(m: string | null | undefined): m is NbaPropMarket {
  return !!m && (NBA_PROP_MARKETS as readonly string[]).includes(m);
}
