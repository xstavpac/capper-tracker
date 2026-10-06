// Team recognition derived from a live game feed's own team data, for teams
// the hand-kept lists in parse-catalog.ts don't carry - today every FCS school
// on the NCAAF score feed. Pure and sync (no network, no DB): the server builds
// the FeedTeam list from the same feed import matching and /live scores read,
// and parseCatalog consults it (see feedTeamNicknames there).
//
// A team is matched by its full feed name ("Montana State Bobcats"), its
// school ("Montana State"), the feed's short form ("Montana St"), or its
// mascot when no other team in the feed shares it. The exact school always
// wins over a near-match:
//   - the longest match wins, so "Idaho State" is the Bengals, never Idaho;
//   - a school / short-form / mascot match must stand alone - the words next
//     to it have to be bet or matchup words - so "Idaho State" with only Idaho
//     in the feed matches nothing rather than Idaho.
// Nothing here guesses: no match, or a tie, returns no hit.

export type FeedTeam = {
  // Sport LABEL as parse-catalog / LIVE_SPORTS use it ("NCAAF").
  sport: string;
  // Full display name exactly as the feed spells it ("Montana State Bobcats").
  name: string;
  // The school part of that name ("Montana State").
  location: string;
  // The feed's short form, when it differs from the school ("Montana St").
  shortName?: string;
  // Set only when no other team in the same feed has this mascot.
  mascot?: string;
};

export type FeedTeamHit = {
  team: FeedTeam;
  start: number;
  end: number;
  via: "name" | "location" | "short" | "mascot";
};

type FeedGame = {
  homeTeam: string;
  awayTeam: string;
  homeLocation?: string;
  awayLocation?: string;
  homeShortName?: string;
  awayShortName?: string;
};

const MIN_MASCOT_LENGTH = 4;

// Every distinct team in a feed's games. A team with no school split (the feed
// didn't send one) is skipped - there is nothing safe to derive a key from.
export function buildFeedTeams(sport: string, games: FeedGame[]): FeedTeam[] {
  const byName = new Map<string, FeedTeam>();
  for (const g of games) {
    const sides: [string, string | undefined, string | undefined][] = [
      [g.homeTeam, g.homeLocation, g.homeShortName],
      [g.awayTeam, g.awayLocation, g.awayShortName],
    ];
    for (const [name, location, shortName] of sides) {
      if (!name || !location || byName.has(name) || !name.startsWith(location)) continue;
      byName.set(name, {
        sport,
        name,
        location,
        ...(shortName && shortName !== location ? { shortName } : {}),
      });
    }
  }

  const teams = [...byName.values()];
  const mascotOf = (t: FeedTeam) => t.name.slice(t.location.length).trim();
  const mascotCount = new Map<string, number>();
  for (const t of teams) {
    const key = fold(mascotOf(t));
    mascotCount.set(key, (mascotCount.get(key) ?? 0) + 1);
  }
  return teams.map((t) => {
    const mascot = mascotOf(t);
    return mascot.length >= MIN_MASCOT_LENGTH && mascotCount.get(fold(mascot)) === 1 ? { ...t, mascot } : t;
  });
}

// Lowercase with diacritics folded ("San José" -> "san jose"). Length is
// unchanged for precomposed input, so match offsets line up with the same
// offsets in text.toLowerCase().
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// "State" also matches "St" / "St.", a trailing period is optional, and an
// apostrophe may be left out ("Hawai'i" / "Hawaii").
function keyRegex(key: string): RegExp {
  const parts = fold(key)
    .split(/\s+/)
    .filter(Boolean)
    .map((word, i) => {
      if (word === "state" && i > 0) return "(?:state|st\\.?)";
      const bare = word.replace(/\.$/, "");
      const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/['\u2019]/g, "['\u2019]?");
      return word.endsWith(".") || bare === "st" ? escaped + "\\.?" : escaped;
    });
  return new RegExp("(?<![\\w&])" + parts.join("\\s+") + "(?![\\w&])");
}

// Words allowed directly before / after a school, short form or mascot.
// Anything else alphabetic there means a longer name we only part-matched
// ("Idaho State", "Charleston Southern", "Montana Tech").
const BEFORE_OK = /^(vs|v|at|and|of|the|on|take|taking|play|lean|bet|pod|lock|max|ncaaf|cfb|fcs|college|football|university)$/;
const AFTER_OK =
  /^(ml|moneyline|money|line|pk|pick|pickem|tt|ats|vs|v|at|and|over|under|o|u|spread|spreads|total|totals|first|second|half|reg|alt|team|to|win|wins|university|college|univ|plus|minus|game|fg|full)$/;

function standsAlone(folded: string, start: number, end: number): boolean {
  const before = folded.slice(0, start).match(/([a-z][\w&'.-]*)\s+$/)?.[1];
  if (before && !BEFORE_OK.test(before.replace(/\.$/, ""))) return false;
  const after = folded.slice(end).match(/^\s+([a-z][\w&'-]*)/)?.[1];
  if (after && !AFTER_OK.test(after)) return false;
  return true;
}

// Every feed team named in `text`, in text order. One hit per team (its
// longest matching key); a hit inside another team's longer hit is dropped,
// and so are hits that tie on the same span.
export function findFeedTeamHits(text: string, teams: FeedTeam[]): FeedTeamHit[] {
  const folded = fold(text);
  const hits: FeedTeamHit[] = [];

  for (const team of teams) {
    const keys: [FeedTeamHit["via"], string | undefined][] = [
      ["name", team.name],
      ["location", team.location],
      ["short", team.shortName],
      ["mascot", team.mascot],
    ];
    for (const [via, key] of keys) {
      if (!key) continue;
      const m = keyRegex(key).exec(folded);
      if (!m) continue;
      const start = m.index;
      const end = start + m[0].length;
      if (via !== "name" && !standsAlone(folded, start, end)) continue;
      hits.push({ team, start, end, via });
      break;
    }
  }

  return hits
    .filter(
      (h) =>
        !hits.some(
          (o) =>
            o !== h &&
            o.start <= h.start &&
            o.end >= h.end &&
            // strictly longer wins; an exact tie drops both
            (o.end - o.start > h.end - h.start || (o.start === h.start && o.end === h.end))
        )
    )
    .sort((a, b) => a.start - b.start);
}
