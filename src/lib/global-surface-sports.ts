// Leagues kept off the surfaces that span every league at once.
//
// NCAAB's slate is up to ~180 games a day (verified live 2026-11-02: 182), more
// than every other league's together on a busy day. On a surface that lists
// "what is happening across all sports" that drowns the rest, and on the page
// that opens by itself it would be the usual landing league. So:
//
//   - the ticker (every app page's layout, and the public score feeds behind
//     it) leaves NCAAB out;
//   - /live never opens on NCAAB by itself. It stays one click away in the tab
//     row (after NCAAF) and a ?sport=basketball_ncaab link is never overridden.
//
// Pure: imported by server data modules, API routes and tests alike.
import { NCAAB_SPORT_KEY } from "@/lib/final-pick-gate";

export const TICKER_EXCLUDED_SPORT_KEYS: ReadonlySet<string> = new Set([NCAAB_SPORT_KEY]);
export const DEFAULT_TAB_EXCLUDED_SPORT_KEYS: ReadonlySet<string> = new Set([NCAAB_SPORT_KEY]);

// Whether a league takes part in the ticker and its public score feeds.
export function isTickerSportKey(sportKey: string): boolean {
  return !TICKER_EXCLUDED_SPORT_KEYS.has(sportKey);
}
