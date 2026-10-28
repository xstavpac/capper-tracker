// Which FanDuel player a pick's typed name means. Pure.
//
// FanDuel's props carry the player's full name (the outcome's `description`);
// a pick can say "Domantas Sabonis", "Sabonis", "Jokić", "Jaren Jackson" for
// "Jaren Jackson Jr.", or a capper's nickname ("SGA"). Tried in this order, and
// the first step that finds anyone decides:
//   1. the whole name, accents, case, punctuation and Jr./Sr./II/III aside
//   2. the league's capper alias for it (nba-player-aliases.ts, nfl-player-aliases.ts)
//   3. the typed words as the END of exactly one name ("Sabonis", "St. Brown") -
//      two players that fit are ambiguous and neither is sent, never a pick
//      between them
// Never a first name alone, and never a partial that isn't the end of a name.
import { foldDiacritics } from "@/lib/fuzzy-match";
import { nbaPlayerAliasName } from "@/lib/nba-player-aliases";
import { nflPlayerAliasName } from "@/lib/nfl-player-aliases";

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

// "De'Aaron Fox" -> [deaaron, fox]; "Amon-Ra St. Brown" -> [amon, ra, st, brown];
// "Jaren Jackson Jr." -> [jaren, jackson]. A generational suffix is dropped
// from both sides of every comparison (FanDuel and the pick often disagree on it).
export function nameWords(name: string): string[] {
  const words = foldDiacritics(name)
    .toLowerCase()
    .replace(/['’‘`´]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1])) words.pop();
  return words;
}

export type PlayerMatch = { status: "found"; name: string } | { status: "ambiguous"; names: string[] } | { status: "none" };

function aliasFor(typed: string, sportKey: string | undefined): string | null {
  if (sportKey === "basketball_nba") return nbaPlayerAliasName(typed);
  if (sportKey === "americanfootball_nfl" || sportKey === "americanfootball_ncaaf") return nflPlayerAliasName(typed);
  return null;
}

const compact = (words: string[]) => words.join("");

function endsWithWords(name: string[], tail: string[]): boolean {
  if (tail.length === 0 || tail.length >= name.length) return false;
  return tail.every((w, i) => name[name.length - tail.length + i] === w);
}

export function resolveFanDuelPlayer(typed: string, sportKey: string | undefined, candidates: Iterable<string>): PlayerMatch {
  const typedWords = nameWords(typed);
  if (typedWords.length === 0) return { status: "none" };

  // Each distinct name once, as FanDuel spells it.
  const byKey = new Map<string, { name: string; words: string[] }>();
  for (const name of candidates) {
    const words = nameWords(name);
    if (words.length > 0 && !byKey.has(compact(words))) byKey.set(compact(words), { name, words });
  }
  const names = Array.from(byKey.values());

  const exact = (words: string[]) => names.filter((n) => compact(n.words) === compact(words));
  const decide = (hits: { name: string }[]): PlayerMatch | null =>
    hits.length === 1 ? { status: "found", name: hits[0].name } : hits.length > 1 ? { status: "ambiguous", names: hits.map((h) => h.name) } : null;

  const whole = decide(exact(typedWords));
  if (whole) return whole;

  const alias = aliasFor(typed, sportKey);
  const aliased = alias ? decide(exact(nameWords(alias))) : null;
  if (aliased) return aliased;

  return decide(names.filter((n) => endsWithWords(n.words, typedWords))) ?? { status: "none" };
}
