// The order a sport's "record by category" tiles are shown in - /live's panel and the capper
// page's market breakdown: most picks first, so a sport's busiest markets (Over, Fav ML, Points
// props...) lead and a market with a handful of picks sits at the end instead of mid-grid.
//
// "Picks" is the tile's own decided count (wins + losses + pushes) - the number its record is
// built from, already in the tile, so ordering reads nothing new from the database. A tile with
// no decided pick yet (one showing only because it has picks on today's board) counts 0.
// Stable: equal counts keep the chip set's order (Array.prototype.sort is stable).
//
// Client-safe, pure.

export type CountedTile = { wins: number; losses: number; pushes: number };

export function decidedPickCount(tile: CountedTile): number {
  return tile.wins + tile.losses + tile.pushes;
}

export function orderTilesByPickCount<T extends CountedTile>(tiles: readonly T[]): T[] {
  return [...tiles].sort((a, b) => decidedPickCount(b) - decidedPickCount(a));
}

// /live shows the first two rows of six; "See more" opens the rest.
export const CATEGORY_TILES_COLLAPSED = 12;

// The tiles shown, and whether the See more / Show less toggle renders (only past 12 tiles).
// Collapsed is the default.
export function visibleCategoryTiles<T>(tiles: readonly T[], expanded: boolean): { shown: readonly T[]; toggle: boolean } {
  const toggle = tiles.length > CATEGORY_TILES_COLLAPSED;
  return { shown: toggle && !expanded ? tiles.slice(0, CATEGORY_TILES_COLLAPSED) : tiles, toggle };
}
