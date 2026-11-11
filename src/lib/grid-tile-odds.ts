import type { OddsGame } from "@/server/data/odds";

function formatOdds(price: number) {
  return price > 0 ? "+" + price : String(price);
}

// What a tile shows from the board's odds: each side's moneyline price (first
// book carrying h2h) and the game total (first book carrying totals) - the same
// first-book-wins reads the Feed card does (live-scoreboard.tsx), kept local so
// the Feed card is untouched.
export function tileOdds(game: OddsGame): { away: string | null; home: string | null; total: string | null } {
  const market = (key: string) => {
    for (const b of game.bookmakers ?? []) {
      const m = b?.markets?.find((x) => x.key === key);
      if (m) return m;
    }
    return undefined;
  };
  const h2h = market("h2h");
  const price = (team: string) => {
    const p = h2h?.outcomes.find((o) => o.name === team)?.price;
    return typeof p === "number" ? formatOdds(p) : null;
  };
  const point = market("totals")?.outcomes.find((o) => o.name === "Over")?.point;
  return { away: price(game.awayTeam), home: price(game.homeTeam), total: typeof point === "number" ? String(point) : null };
}
