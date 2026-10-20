// MLB player-name matching - pure, shared by the box-score grader
// (mlb-prop-grading.ts) and the roster recovery pass (mlb-roster-fallback.ts).
//
// Why MLB gets its own normalizer instead of fuzzy-match.ts's normalizeName: that one
// strips every non-[a-z0-9] character, so an accented letter VANISHES ("José" ->
// "js") instead of folding to its base letter, and it keeps middle initials. Two real
// Stats API box scores from this postseason window show the consequences:
//   - typed "Jose Ferrer"      vs box "José A. Ferrer"  (accent + middle initial)
//   - typed "Alexander Cook"   vs box "Alex Cook"        (first-name short form)
// NFL/NHL keep normalizeName untouched; only MLB uses this.
//
// Tiers, each counting ONLY if it narrows to exactly one distinct player id (same policy
// as player-roster-fallback.ts / nhl-prop-grading.ts):
//   1. exact folded full name            ("jose ferrer" == "jose ferrer")
//   2. same surname + compatible first   (one first name is a >=3-char prefix of the other -
//      name                               Alex/Alexander - or both are in the same FIRST_NAME_ALIASES
//                                         group - Mike/Michael, Nick/Nicholas; other nicknames are
//                                         deliberately not guessed)
//   3. fuzzy full name                   (isLikelyDuplicateName on the folded names -
//                                         typos only)
//   4. bare surname (single typed token only)
// An ambiguous tier reports "many" and stops: a collision is exactly the case where
// we must not guess (there are two real "Max Muncy"s in the 2026 MLB rosters).
import { isLikelyDuplicateName } from "@/lib/fuzzy-match";

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

// Lower-cased, accent-folded, punctuation-free token list; generational suffix and single-letter
// middle initials removed (first and last tokens always kept).
export function mlbNameTokens(name: string): string[] {
  const folded = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'’`]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/-/g, " ");
  let tokens = folded.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1])) tokens = tokens.slice(0, -1);
  if (tokens.length > 2) tokens = tokens.filter((t, i) => i === 0 || i === tokens.length - 1 || t.length > 1);
  return tokens;
}

export function mlbNameKey(name: string): string {
  return mlbNameTokens(name).join(" ");
}

// `tier` is the tier that matched (numbered as in the header): "short-form" and "fuzzy" are the
// near-misses - the typed name is not the player's own spelling - which the roster recovery pass
// resolves silently only when the player's team is in the pick's game.
export type MlbNameTier = "exact" | "short-form" | "fuzzy" | "surname";
export type MlbNameMatch<T> = { status: "one"; item: T; tier: MlbNameTier } | { status: "many"; items: T[]; tier: MlbNameTier } | { status: "none" };

export type MlbMatchOptions = { allowFuzzy?: boolean; allowSurname?: boolean };

// Standard English first-name short forms a >=3-char prefix can't catch (mike/michael,
// nick/nicholas, joe/joseph, jim/james, bill/william, tony/anthony). Each group is one person's
// name in different registers; prefix pairs like matt/matthew or chris/christopher are covered by the
// prefix rule below but listed anyway so the table stands on its own. Deliberately conservative:
// a pair appears only when it is a real, common short form - never a guess between two different
// first names (bobby/robert and similar hypocorisms stay unmatched). Matching still requires the same
// surname AND a unique result, so a table hit alone never resolves anything.
const FIRST_NAME_ALIASES: string[][] = [
  ["mike", "mikey", "michael"],
  ["nick", "nicholas", "nico"],
  ["matt", "matthew"],
  ["chris", "christopher"],
  ["alex", "alexander"],
  ["joe", "joey", "joseph"],
  ["jim", "jimmy", "james"],
  ["bill", "billy", "will", "willie", "william"],
  ["tony", "anthony"],
  ["dave", "david"],
  ["dan", "danny", "daniel"],
  ["tom", "tommy", "thomas"],
  ["ben", "benny", "benjamin"],
  ["josh", "joshua"],
  ["jake", "jacob"],
  ["andy", "drew", "andrew"],
  ["ed", "eddie", "edward"],
  ["sam", "samuel"],
  ["zach", "zack", "zachary"],
];
const ALIAS_GROUP = new Map<string, number>();
FIRST_NAME_ALIASES.forEach((group, i) => group.forEach((n) => ALIAS_GROUP.set(n, i)));

function firstNamesCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  const ga = ALIAS_GROUP.get(a);
  if (ga !== undefined && ga === ALIAS_GROUP.get(b)) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short);
}

export function matchMlbName<T>(
  typed: string,
  items: T[],
  id: (i: T) => string,
  fullName: (i: T) => string,
  opts: MlbMatchOptions = {}
): MlbNameMatch<T> {
  const { allowFuzzy = true, allowSurname = true } = opts;
  const t = mlbNameTokens(typed);
  if (t.length === 0) return { status: "none" };
  const tKey = t.join(" ");
  const tFirst = t[0];
  const tLast = t[t.length - 1];
  const distinct = (xs: T[]) => [...new Map(xs.map((x) => [id(x), x])).values()];

  const tiers: { tier: MlbNameTier; hits: T[] }[] = [{ tier: "exact", hits: items.filter((i) => mlbNameKey(fullName(i)) === tKey) }];
  if (t.length >= 2) {
    tiers.push({
      tier: "short-form",
      hits: items.filter((i) => {
        const n = mlbNameTokens(fullName(i));
        return n.length >= 2 && n[n.length - 1] === tLast && firstNamesCompatible(n[0], tFirst);
      }),
    });
    if (allowFuzzy) tiers.push({ tier: "fuzzy", hits: items.filter((i) => isLikelyDuplicateName(mlbNameKey(fullName(i)), tKey)) });
  }
  if (t.length === 1 && allowSurname) {
    tiers.push({
      tier: "surname",
      hits: items.filter((i) => {
        const n = mlbNameTokens(fullName(i));
        return n.length >= 1 && n[n.length - 1] === tFirst;
      }),
    });
  }
  for (const { tier, hits } of tiers) {
    const d = distinct(hits);
    if (d.length === 1) return { status: "one", item: d[0], tier };
    if (d.length > 1) return { status: "many", items: d, tier };
  }
  return { status: "none" };
}
