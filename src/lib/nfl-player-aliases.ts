// What cappers call NFL players, mapped to the name the NFL roster (ESPN) uses - the NFL twin of
// nba-player-aliases.ts, same rules. Pure module, no imports beyond the name helpers. Read by
// resolvePlayerPropAgainstRoster for an NFL line only: an NFL alias never fires for another league.
//
// Keys are compared folded and with everything but letters and digits removed ("C.M.C." = "cmc").
//
// Rules for an entry (the acceptance test checks them):
//   - the value is the roster's full name and the lookup still goes through the roster: an alias
//     never bypasses it, and a player who is not on the roster (any more) is matched as typed;
//   - the key is not another rostered player's surname or a position;
//   - it means one player. Left out on purpose: AB, JJ, DK, CD, OBJ and nicknames - each is two
//     players, a position, or a name the league does not settle.
import { foldDiacritics, normalizeName } from "@/lib/fuzzy-match";

const ALIASES: Record<string, string[]> = {
  "Christian McCaffrey": ["CMC"],
};

const key = (s: string) => normalizeName(foldDiacritics(s));

export const NFL_PLAYER_ALIASES: ReadonlyMap<string, string> = new Map(
  Object.entries(ALIASES).flatMap(([full, aliases]) => aliases.map((a) => [key(a), full] as const))
);

// The roster name a typed name is an alias of, or null.
export function nflPlayerAliasName(typed: string): string | null {
  return NFL_PLAYER_ALIASES.get(key(typed)) ?? null;
}
