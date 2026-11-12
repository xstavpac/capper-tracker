// Team logo URLs for the Live page: ESPN's own logo CDN, taken from the
// `team.logo` field the ESPN scoreboard already returns for every team.
// (The logo images were removed once in cc1852a for licensing reasons; their
// return is an explicit, accepted product decision.)
//
// Pure and dependency-free so both the server (score feed mapping) and client
// components can import it.

const ESPN_LOGO_PREFIX = "https://a.espncdn.com/i/teamlogos/";

// The scoreboard's pro-league logos live under /500/scoreboard/{abbr}.png, but
// that variant is missing for 9 of 14 WNBA teams (checked live 2026-11-12). The
// plain /500/{abbr}.png exists for every team in every league checked, so the
// "/scoreboard" segment is dropped. College logos (/ncaa/500/{id}.png) have no
// such segment and pass through unchanged.
export function normalizeEspnLogoUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const url = raw.trim();
  // Only ESPN's logo CDN, over https: this string ends up in an <img src>, so
  // anything else (a different host, a data: or javascript: URL) is rejected.
  if (!url.startsWith(ESPN_LOGO_PREFIX) || !/\.png$/.test(url)) return null;
  return url.replace("/500/scoreboard/", "/500/");
}

// MLB scores come from the MLB Stats API, not ESPN, so there is no `team.logo`
// on that feed. Stats API team id -> ESPN's abbreviation for the same team
// (joined by team name against ESPN's /teams list and confirmed 30/30 on
// 2026-11-12; every resulting URL returned 200).
const MLB_STATS_ID_TO_ESPN_ABBR: Record<number, string> = {
  108: "laa",
  109: "ari",
  110: "bal",
  111: "bos",
  112: "chc",
  113: "cin",
  114: "cle",
  115: "col",
  116: "det",
  117: "hou",
  118: "kc",
  119: "lad",
  120: "wsh",
  121: "nym",
  133: "ath",
  134: "pit",
  135: "sd",
  136: "sea",
  137: "sf",
  138: "stl",
  139: "tb",
  140: "tex",
  141: "tor",
  142: "min",
  143: "phi",
  144: "atl",
  145: "chw",
  146: "mia",
  147: "nyy",
  158: "mil",
};

export function mlbLogoUrl(statsApiTeamId: unknown): string | null {
  if (typeof statsApiTeamId !== "number") return null;
  const abbr = MLB_STATS_ID_TO_ESPN_ABBR[statsApiTeamId];
  return abbr ? `${ESPN_LOGO_PREFIX}mlb/500/${abbr}.png` : null;
}

// The two logos of a matched score row, for an odds-spelled card. Home/away are
// the same sides on both feeds (matchScoreToGame requires home-to-home and
// away-to-away), so no per-name lookup is needed. Null/undefined score (a card
// that did not match a game, or a game outside the score window) yields no logos.
export function scoreLogos(
  score: { homeLogoUrl?: string | null; awayLogoUrl?: string | null } | null | undefined
): { home: string | null; away: string | null } {
  return { home: score?.homeLogoUrl ?? null, away: score?.awayLogoUrl ?? null };
}
