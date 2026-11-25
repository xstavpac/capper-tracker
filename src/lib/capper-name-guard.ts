// Capper-name guard for the AUTOMATED import paths only (Telegram ingest, bot API token ingest, pick-recipient copies).
// Manual paths (the catalog import form, the Add capper form) never call this: a name a person typed is theirs.
//
// Three questions, all pure (no database, no network):
//   1. isPromoLine         - is this line channel promo text ("2 DAYS FOR THE PRICE OF 1")? Dropped before parsing.
//   2. capperNameJunkReason - is this header clearly NOT a person or brand (a number, bet syntax, a team, a roster
//                            player, promo text, a bare pick fragment like "LOCKS")? Then it never becomes a capper.
//   3. findCapperVariant    - is this name an obvious variant of exactly ONE saved capper ("DIRTY BUBBLE" for
//                            DirtyBubbleBets, "SenseiSam VIP" for SENSEI Sam)? Then the pick is filed there.
//
// The rules are deliberately conservative: a false "junk" moves a header's picks to the header above it, and a false
// variant files picks under the wrong capper. Anything unsure is left alone (and, for a new name, goes to review).
import { normalizeName, capperPairKeys, type StoredCapperNameDecision } from "@/lib/fuzzy-match";
import { isTeamPhrase } from "@/lib/parse-catalog";
import type { FeedTeam } from "@/lib/feed-teams";

export type CapperJunkReason = "number" | "bet_syntax" | "team" | "player" | "promo" | "fragment";

// Emoji, keycaps, variation selectors and markdown decoration -> plain text ("2️⃣**DAYS" -> "2 DAYS").
export function stripNameDecoration(text: string): string {
  return text
    .replace(/[︎️⃣‍]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[*_~`|#>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PROMO_PATTERNS: RegExp[] = [
  /\bfor the price of\b/i,
  /\bget on board\b/i,
  /\bstill (have|got) time\b/i,
  /\b(limited|last) (time|chance|spots?)\b/i,
  /\b(sign|signup|sign-up) (up|now|today)\b/i,
  /\bjoin (now|today|us|the vip|vip)\b/i,
  /\b(dm|message) (me|us)\b/i,
  /\bsubscribe\b/i,
  /\b\d+\s?% off\b/i,
  /\b(promo|discount|coupon) code\b/i,
  /\blink in (bio|description)\b/i,
  /\bfree trial\b/i,
  /\bt\.me\//i,
  /\b(buy|purchase|grab) (now|today|access|the package|a package)\b/i,
  /\bdon'?t miss (out|this)\b/i,
  /\b(\d+|one|two|three|four|five|six|seven) days? (for|of) (free|the price)\b/i,
];

// Channel promo text. Checked on the plain text, so emoji / markdown decoration doesn't hide it.
export function isPromoLine(line: string): boolean {
  const plain = stripNameDecoration(line);
  if (!plain) return false;
  return PROMO_PATTERNS.some((re) => re.test(plain));
}

// Bet syntax inside a name. Kept narrow on purpose (no bare "over" / "under" - "Over Achievers" is a real capper).
const BET_SYNTAX_PATTERNS: RegExp[] = [
  /\bml\b/i, // moneyline
  /\bmlp\b/i, // ("parlay" alone is not here: "PARLAY SAFARI" is a real capper; a parlay line still has MLP or "A + B")
  /\bmoneyline\b/i,
  /(^|\s)[+-]\d{3,4}\b/, // American odds
  /(^|\s)[+-]?\d+\.5\b/, // a half-point line
  /(^|\s)[ou]\s?\d+(\.\d)?\b/i, // o8.5 / u 220
  /\S\s*\+\s*\S/, // "A + B" (teams joined)
  /\b\d+(\.\d+)?\s?u(nits?)?\b/i, // 2u / 1.5 units
  /\b(pts|reb|rebs|ast|asts|sog|td|tds|hr|hrs|rbi|rbis|ks|nrfi|yrfi|f5|1h|2h|1p|1q)\b/i,
  /\b(anytime|goals?|touchdowns?|strikeouts|rebounds|assists|points|yards|receptions|spread)\b/i,
];

// Whole names that are pick-post furniture, never a capper.
const FRAGMENT_WORDS = new Set(
  [
    "lock", "locks", "lotd", "potd", "potw", "play", "plays", "bomb", "bombs", "max", "maxbet", "whale", "whales",
    "pick", "picks", "bet", "bets", "free", "freebie", "freeplay", "freeplays", "today", "tonight", "todays", "sweat",
    "nuke", "nuked", "cash", "cashed", "winner", "winners", "hit", "hits", "live", "livebet", "bonus", "lotto",
    "parlay", "parlays", "mlp", "props", "prop", "sgp", "vip", "premium", "update", "updates", "results", "recap",
    "nba", "nfl", "nhl", "mlb", "ncaab", "ncaaf", "cbb", "cfb", "wnba", "nba picks", "nfl picks",
  ].map((w) => normalizeName(w))
);

export type JunkCheckContext = {
  feedTeams?: FeedTeam[];
  // Roster players' full names, normalized with normalizeName.
  playerKeys?: ReadonlySet<string>;
};

// Why `name` cannot be a capper, or null when it can. Order matters only for the reason reported.
export function capperNameJunkReason(name: string, ctx: JunkCheckContext = {}): CapperJunkReason | null {
  const plain = stripNameDecoration(name);
  if (!/\p{L}/u.test(plain)) return "number"; // "3.5", "+150", "2️⃣", ""
  if (isPromoLine(plain)) return "promo";
  if (BET_SYNTAX_PATTERNS.some((re) => re.test(plain))) return "bet_syntax";
  const key = normalizeName(plain);
  if (key === "") return "number";
  if (FRAGMENT_WORDS.has(key)) return "fragment";
  if (isTeamPhrase(plain, ctx.feedTeams ?? [])) return "team";
  if (ctx.playerKeys?.has(key)) return "player";
  return null;
}

// ---- variants ----

// Trailing words a capper adds to or drops from their own name.
const SUFFIX_WORDS = ["vip", "bets", "bet", "picks", "pick", "plays", "sports", "official", "tips"];
const MIN_KEY = 4; // a cleaned / suffix-stripped key must keep at least this many characters
const MIN_WORD_DROP_KEY = 5; // stricter when a whole word was dropped
const MAX_GLUED_TAIL = 2; // "MCBETSCS" -> "MCBETS": at most this many extra trailing characters
// A dropped trailing word must look like a person's name tacked on ("Empire Sam", "Cash It, Baby Carlos"): short, and
// not a word that makes a different brand ("Sharp investments" and "SHARP SHEET" are not "SHARP").
const MAX_DROPPED_WORD = 7;
const BRAND_WORDS = new Set([
  "sheet", "sheets", "investments", "investment", "money", "sports", "picks", "pick", "bets", "bet", "locks", "lock",
  "plays", "play", "guy", "guys", "king", "kings", "club", "group", "analytics", "capper", "cappers", "insider", "sharp",
  "sharps", "office", "labs", "lab", "wins", "win", "winners", "props", "prop", "parlay", "parlays", "dfs", "vip", "live",
]);

// Lowercase words with decoration, punctuation and any parenthetical (closed or not) removed.
function nameWords(name: string): string[] {
  const plain = stripNameDecoration(name).replace(/\(.*$/, " ").replace(/\[.*$/, " ");
  return plain
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
}

function stripSuffixes(key: string): string {
  let k = key;
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of SUFFIX_WORDS) {
      if (k.endsWith(s) && k.length - s.length >= MIN_KEY) {
        k = k.slice(0, -s.length);
        changed = true;
      }
    }
  }
  return k;
}

// The name's own keys (the whole name, cleaned, suffix-stripped) and its keys with the last word dropped.
function variantKeys(name: string): { full: Set<string>; dropped: Set<string> } {
  const words = nameWords(name);
  const whole = words.join("");
  const full = new Set([whole, stripSuffixes(whole)].filter((k) => k.length >= MIN_KEY));
  const dropped = new Set<string>();
  const last = words[words.length - 1] ?? "";
  if (words.length >= 2 && last.length <= MAX_DROPPED_WORD && !BRAND_WORDS.has(last)) {
    const rest = words.slice(0, -1).join("");
    for (const k of [rest, stripSuffixes(rest)]) if (k.length >= MIN_WORD_DROP_KEY) dropped.add(k);
  }
  return { full, dropped };
}

function isVariantPair(raw: string, saved: string): boolean {
  const a = variantKeys(raw);
  const b = variantKeys(saved);
  for (const k of a.full) if (b.full.has(k) || b.dropped.has(k)) return true;
  for (const k of a.dropped) if (b.full.has(k)) return true;
  // One glued name with a short extra tail ("MCBETSCS" / "MCBETS"), either way round.
  for (const x of a.full)
    for (const y of b.full) {
      const [short, long] = x.length <= y.length ? [x, y] : [y, x];
      if (short.length >= MIN_WORD_DROP_KEY && long !== short && long.startsWith(short) && long.length - short.length <= MAX_GLUED_TAIL) return true;
    }
  return false;
}

// The ONE saved capper `name` is an obvious variant of, or null (no match, two or more matches, an exact match -
// that needs no rewrite - or a pair the user already answered DIFFERENT).
export function findCapperVariant(
  name: string,
  saved: readonly string[],
  decisions: readonly StoredCapperNameDecision[] = []
): string | null {
  const own = normalizeName(name);
  if (own !== "" && saved.some((s) => normalizeName(s) === own)) return null;
  const differentFrom = (s: string) => {
    const { rawKey, suggestedKey } = capperPairKeys(name, s);
    return decisions.some((d) => d.rawKey === rawKey && d.suggestedKey === suggestedKey && d.decision === "DIFFERENT");
  };
  // "[name] VIP" always files under the base capper - checked first, because it also reaches short names ("AFS VIP")
  // that the general rules below keep exact-only. Two saved cappers match the base: ambiguous, left alone.
  const base = vipBase(name);
  if (base !== null) {
    const core = stripSuffixes(base);
    const matches = saved.filter((s) => {
      const k = normalizeName(s);
      return k !== "" && (k === base || stripSuffixes(k) === base || stripSuffixes(k) === core);
    });
    const distinct = Array.from(new Map(matches.map((m) => [normalizeName(m), m])).values());
    if (distinct.length > 1) return null;
    if (distinct.length === 1) return differentFrom(distinct[0]) ? null : distinct[0];
  }
  const hits = saved.filter((s) => normalizeName(s) !== "" && isVariantPair(name, s));
  const unique = Array.from(new Map(hits.map((h) => [normalizeName(h), h])).values());
  if (unique.length !== 1) return null;
  return differentFrom(unique[0]) ? null : unique[0];
}

// "KimsVIP", "Kims VIP", "KIMS-VIP": the cleaned name ends in "vip" and something real is left of it.
const MIN_VIP_BASE = 2;
function vipBase(name: string): string | null {
  const key = nameWords(name).join("");
  if (!key.endsWith("vip")) return null;
  const base = key.slice(0, -3);
  return base.length >= MIN_VIP_BASE ? base : null;
}

// The saved capper a name has been SET to by the account owner: a stored capper_name_decisions SAME answer for exactly
// this name (rawKey) whose suggestedKey is a saved capper. It does not depend on how alike the two names look, so it
// reaches "Alex Caruso" -> "Caruso", and it overrides the roster-player / team rules (the owner said it is a capper).
// null: no answer, the answer points at nothing saved, or several saved cappers (left alone).
export function savedAliasOf(name: string, saved: readonly string[], decisions: readonly StoredCapperNameDecision[]): string | null {
  const raw = normalizeName(name);
  if (raw === "") return null;
  if (saved.some((s) => normalizeName(s) === raw)) return null; // already a saved capper: nothing to rewrite
  const keys = new Set(decisions.filter((d) => d.decision === "SAME" && d.rawKey === raw).map((d) => d.suggestedKey));
  if (keys.size === 0) return null;
  const hits = Array.from(new Map(saved.filter((s) => keys.has(normalizeName(s))).map((s) => [normalizeName(s), s])).values());
  return hits.length === 1 ? hits[0] : null;
}

// Can this NEW header line (not an exact saved capper) be a capper? Yes when the account owner has set it to a saved
// capper, or when it is not junk.
export function isCapperHeader(
  name: string,
  saved: readonly string[],
  decisions: readonly StoredCapperNameDecision[],
  ctx: JunkCheckContext = {}
): boolean {
  return savedAliasOf(name, saved, decisions) !== null || capperNameJunkReason(name, ctx) === null;
}

// Pick-recipient copies: the capper each source capper name is filed under on the recipient's account. null = the
// copy is not delivered (the name is junk - normally impossible, since the source import is guarded, but a source's
// older junk capper must not spread). A name with no saved match keeps its own name: the source user's capper was
// created on purpose (by hand or from the review queue), so the recipient gets it too, as before.
export function recipientCapperName(
  sourceName: string,
  recipientSaved: readonly string[],
  // The recipient's own stored answers: a SAME answer files the name under that saved capper before any other rule.
  decisions: readonly StoredCapperNameDecision[] = []
): string | null {
  const alias = savedAliasOf(sourceName, recipientSaved, decisions);
  if (alias !== null) return alias;
  if (capperNameJunkReason(sourceName) !== null) return null;
  return findCapperVariant(sourceName, recipientSaved, decisions) ?? sourceName;
}
