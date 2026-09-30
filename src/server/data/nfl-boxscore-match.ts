// Grading-time player matching for NFL player props: the pure half (no fetch,
// no prisma - fixture-testable). grading.ts fetches ESPN's summary response
// and roster, this file turns them into something matchable.
//
// Why this exists: grading used to compare the pick's typed name to ESPN's
// displayName with isLikelyDuplicateName alone. That fails on
//   - a generational suffix ESPN includes and a capper doesn't
//     ("Kenneth Walker" vs "Kenneth Walker III" - edit distance 3, past the
//     fuzzy threshold), and
//   - a bare surname ("Judkins", "Mooney") - recovery-path picks keep the
//     capper's typed text, so the stored name is often just a last name.
// Import-time matching (player-roster-fallback.ts) already handles both; this
// applies the same policy against the game's own box score.
//
// Tiers (each counts only if it narrows to exactly ONE distinct player; two or
// more is "many" and the pick stays PENDING - never guessed):
//   1. exact normalized full name, suffixes stripped from both sides
//   2. fuzzy full name (same isLikelyDuplicateName), suffixes stripped
//   3. bare surname - only for a single typed word, and only against the
//      offensive players (passing/rushing/receiving groups) of THIS game's two
//      teams, so a defender sharing the surname can't create a false collision
import { normalizeName, isLikelyDuplicateName } from "@/lib/fuzzy-match";
import { stripNameSuffix } from "@/lib/player-roster-fallback";

export type BoxPlayer = {
  espnPlayerId: string | null;
  playerName: string;
  team: string;
  groups: string[]; // every box-score stat group (passing/rushing/...) the player has a row in
};

export type NflBoxIndex = {
  // false only when the summary explicitly says the game isn't completed
  // (header status). Unknown (older/partial payloads) counts as final here;
  // the PUSH path separately requires an explicit true.
  isFinal: boolean;
  explicitlyFinal: boolean;
  teams: string[];
  // Both teams present, each with a populated passing, rushing AND receiving
  // group - the "complete box score" precondition for treating absence as
  // proof the player didn't play.
  isComplete: boolean;
  players: BoxPlayer[];
};

const OFFENSE_GROUPS = ["passing", "rushing", "receiving"];

export function isOffensePlayer(p: BoxPlayer): boolean {
  return p.groups.some((g) => OFFENSE_GROUPS.includes(g));
}

export function indexNflBoxScore(espnSummaryResponse: unknown): NflBoxIndex | null {
  const data = espnSummaryResponse as any;
  const teams: any[] = data?.boxscore?.players ?? [];
  if (teams.length === 0) return null;

  const completed = data?.header?.competitions?.[0]?.status?.type?.completed;
  const byKey = new Map<string, BoxPlayer>();
  const teamNames: string[] = [];
  let complete = teams.length >= 2;

  for (const t of teams) {
    const team: string | undefined = t.team?.displayName;
    if (!team) {
      complete = false;
      continue;
    }
    teamNames.push(team);
    const populated = new Set<string>();
    for (const cat of t.statistics ?? []) {
      const group: string = cat.name;
      for (const a of cat.athletes ?? []) {
        const name: string | undefined = a.athlete?.displayName;
        if (!name) continue;
        if ((cat.athletes ?? []).length > 0) populated.add(group);
        const id: string | null = a.athlete?.id != null ? String(a.athlete.id) : null;
        const key = (id ?? name) + "|" + team;
        const existing = byKey.get(key);
        if (existing) {
          if (!existing.groups.includes(group)) existing.groups.push(group);
        } else {
          byKey.set(key, { espnPlayerId: id, playerName: name, team, groups: [group] });
        }
      }
    }
    if (!OFFENSE_GROUPS.every((g) => populated.has(g))) complete = false;
  }

  return {
    isFinal: completed !== false,
    explicitlyFinal: completed === true,
    teams: teamNames,
    isComplete: complete,
    players: [...byKey.values()],
  };
}

export type NameMatch<T> =
  | { status: "one"; item: T; tier: "exact" | "fuzzy" | "surname" }
  | { status: "many" }
  | { status: "none" };

function lastWord(full: string): string {
  return stripNameSuffix(full).split(/\s+/).pop() ?? full;
}

// `surnamePool` is where the bare-surname tier looks (defaults to `pool`).
// allowFuzzy=false drops tier 2 entirely (used where a fuzzy hit isn't good
// enough evidence, i.e. the did-not-play PUSH).
export function matchNflPlayerName<T>(
  typed: string,
  pool: T[],
  getName: (i: T) => string,
  getId: (i: T) => string | null,
  opts: { surnamePool?: T[]; getLastName?: (i: T) => string; allowFuzzy?: boolean } = {}
): NameMatch<T> {
  const t = stripNameSuffix(typed);
  const nt = normalizeName(t);
  if (!nt) return { status: "none" };

  const distinct = (xs: T[]) => [...new Map(xs.map((x) => [getId(x) ?? getName(x), x])).values()];
  const lastName = opts.getLastName ?? ((i: T) => lastWord(getName(i)));

  const tiers: { tier: "exact" | "fuzzy" | "surname"; hits: T[] }[] = [
    { tier: "exact", hits: pool.filter((i) => normalizeName(stripNameSuffix(getName(i))) === nt) },
  ];
  if (opts.allowFuzzy !== false) {
    tiers.push({ tier: "fuzzy", hits: pool.filter((i) => isLikelyDuplicateName(stripNameSuffix(getName(i)), t)) });
  }
  if (!/\s/.test(t)) {
    tiers.push({
      tier: "surname",
      hits: (opts.surnamePool ?? pool).filter((i) => normalizeName(stripNameSuffix(lastName(i))) === nt),
    });
  }

  for (const { tier, hits } of tiers) {
    const d = distinct(hits);
    if (d.length === 1) return { status: "one", item: d[0], tier };
    if (d.length > 1) return { status: "many" };
  }
  return { status: "none" };
}
