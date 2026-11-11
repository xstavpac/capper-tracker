// tileOdds: the Grid tile's moneyline + total, read first-book-wins like the Feed card.
import { tileOdds } from "@/lib/grid-tile-odds";
import type { OddsGame } from "@/server/data/odds";

let failed = 0;
function check(name: string, ok: boolean) {
  console.log((ok ? "PASS" : "FAIL") + " - " + name);
  if (!ok) failed++;
}
const game = (bookmakers: unknown) => ({ homeTeam: "New York Knicks", awayTeam: "Milwaukee Bucks", bookmakers }) as unknown as OddsGame;

const full = tileOdds(
  game([
    {
      markets: [
        { key: "h2h", outcomes: [{ name: "Milwaukee Bucks", price: 110 }, { name: "New York Knicks", price: -130 }] },
        { key: "totals", outcomes: [{ name: "Over", price: -110, point: 227.5 }, { name: "Under", price: -110, point: 227.5 }] },
      ],
    },
  ])
);
check("positive price gets a plus sign", full.away === "+110");
check("negative price keeps its minus", full.home === "-130");
check("total is the Over point", full.total === "227.5");

const split = tileOdds(game([{ markets: [{ key: "spreads", outcomes: [] }] }, { markets: [{ key: "h2h", outcomes: [{ name: "Milwaukee Bucks", price: -105 }, { name: "New York Knicks", price: -115 }] }] }]));
check("falls through to the first book that has h2h", split.away === "-105" && split.home === "-115");
check("no totals market -> null total", split.total === null);

const none = tileOdds(game([]));
check("no books -> everything null", none.away === null && none.home === null && none.total === null);
const noPrice = tileOdds(game([{ markets: [{ key: "h2h", outcomes: [{ name: "Milwaukee Bucks" }] }] }]));
check("outcome without a price -> null", noPrice.away === null);

if (failed > 0) process.exit(1);
