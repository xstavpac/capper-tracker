// What cappers call NBA players, mapped to the name the NBA roster (ESPN) uses.
// Pure module, no imports beyond the name helpers. Read by nba-roster-fallback.ts
// BEFORE the roster's exact / fuzzy / surname tiers: "SGA", "Wemby", "KAT" and a
// first name alone ("Giannis", "LeBron", "Luka") are none of those tiers.
//
// Keys are compared folded and with everything but letters and digits removed,
// so "Ant-Man" = "antman", "Greek Freak" = "greekfreak", "PG-13" = "pg13".
//
// Rules for an entry:
//   - the value must be a full name on the current NBA roster (the acceptance
//     test checks every one against the 2026-10-13 roster fixture), and
//   - the key must not be another rostered player's surname - an alias never
//     takes a name the surname tier would have resolved to someone else (also
//     checked). A first name only goes in when the league knows the player by
//     it ("Luka" is two players' first name; it means Doncic).
// A player who leaves the league stays harmless: the alias resolves to a name
// the roster no longer has, and matching carries on with what was typed.
import { foldDiacritics, normalizeName } from "@/lib/fuzzy-match";

const ALIASES: Record<string, string[]> = {
  "Shai Gilgeous-Alexander": ["SGA", "Shai"],
  "Victor Wembanyama": ["Wemby"],
  "Giannis Antetokounmpo": ["Giannis", "Greek Freak"],
  "Karl-Anthony Towns": ["KAT"],
  "Anthony Edwards": ["Ant", "Ant-Man", "Ant Edwards"],
  "LeBron James": ["LeBron", "Bron", "King James"],
  "Stephen Curry": ["Steph", "Steph Curry", "Chef Curry"],
  "Luka Doncic": ["Luka"],
  "Joel Embiid": ["Embiid", "Jojo"],
  "Nikola Jokic": ["Joker"],
  "Anthony Davis": ["AD"],
  "Damian Lillard": ["Dame", "Dame Time"],
  "Jaren Jackson Jr.": ["JJJ", "Triple J"],
  "Kevin Durant": ["KD"],
  "Donovan Mitchell": ["Spida"],
  "Paul George": ["PG", "PG13", "PG-13"],
  "Zion Williamson": ["Zion"],
  "Ja Morant": ["Ja"],
  "Trae Young": ["Trae", "Ice Trae"],
  "Chet Holmgren": ["Chet"],
  "Cade Cunningham": ["Cade"],
  "Paolo Banchero": ["Paolo"],
  "LaMelo Ball": ["LaMelo", "Melo"],
  "Bam Adebayo": ["Bam"],
  "Kawhi Leonard": ["Kawhi"],
  "Tyrese Haliburton": ["Hali"],
  "Jalen Williams": ["JDub", "J-Dub"],
  "Jimmy Butler III": ["Jimmy Buckets"],
  "Scottie Barnes": ["Scottie"],
};

const key = (s: string) => normalizeName(foldDiacritics(s));

export const NBA_PLAYER_ALIASES: ReadonlyMap<string, string> = new Map(
  Object.entries(ALIASES).flatMap(([full, aliases]) => aliases.map((a) => [key(a), full] as const))
);

// The roster name a typed name is an alias of, or null.
export function nbaPlayerAliasName(typed: string): string | null {
  return NBA_PLAYER_ALIASES.get(key(typed)) ?? null;
}
