// Neutral-site games have no true home team, and the score feed (ESPN / MLB Stats API)
// and the odds feed (The Odds API) pick differently - Auburn/Notre Dame 2026-11-19: ESPN
// home = Auburn, card home = Notre Dame. Matching a score to a card therefore accepts
// either orientation (same team pair; the caller still picks the nearest start).
//
// A score matched the reversed way is handed back as a MIRRORED copy: teams, logos,
// location/short names and MLB innings (home/away) swapped, so every reader that trusts
// "home is the card's home" (scoreLogos, innings) stays right. `scores` is keyed by team
// NAME, not by side, so it needs no change - each team keeps its own score. One copy per
// score object (WeakMap) so identity-keyed readers see a stable object. Pure, client-safe
// (type-only import), shared by both matchScoreToGame copies so they cannot drift.
import { teamNamesMatch } from "@/lib/team-name-match";
import type { ScoreGame } from "@/server/data/odds";

type Teams = { homeTeam: string; awayTeam: string };

export type TeamOrientation = "same" | "reversed" | null;

export function teamOrientation(feed: Teams, game: Teams, sportKey?: string): TeamOrientation {
  if (teamNamesMatch(feed.homeTeam, game.homeTeam, sportKey) && teamNamesMatch(feed.awayTeam, game.awayTeam, sportKey)) return "same";
  if (teamNamesMatch(feed.homeTeam, game.awayTeam, sportKey) && teamNamesMatch(feed.awayTeam, game.homeTeam, sportKey)) return "reversed";
  return null;
}

const mirrored = new WeakMap<object, ScoreGame>();

export function mirrorScoreGame(s: ScoreGame): ScoreGame {
  const cached = mirrored.get(s);
  if (cached) return cached;
  const m: ScoreGame = {
    ...s,
    homeTeam: s.awayTeam,
    awayTeam: s.homeTeam,
    innings: s.innings ? s.innings.map((i) => ({ ...i, home: i.away, away: i.home })) : s.innings,
  };
  if ("homeLogoUrl" in s || "awayLogoUrl" in s) { m.homeLogoUrl = s.awayLogoUrl; m.awayLogoUrl = s.homeLogoUrl; }
  if ("homeLocation" in s || "awayLocation" in s) { m.homeLocation = s.awayLocation; m.awayLocation = s.homeLocation; }
  if ("homeShortName" in s || "awayShortName" in s) { m.homeShortName = s.awayShortName; m.awayShortName = s.homeShortName; }
  mirrored.set(s, m);
  return m;
}

// The shared body of both matchScoreToGame copies: candidates in either orientation, the
// one starting nearest the card wins (`pick`), returned in the card's orientation.
export function matchScoreEitherWay(
  scores: ScoreGame[],
  game: Teams & { commenceTime: string },
  sportKey: string | undefined,
  pick: (candidates: ScoreGame[], gameStart: number) => ScoreGame
): ScoreGame | undefined {
  const reversed = new Set<ScoreGame>();
  const candidates: ScoreGame[] = [];
  for (const s of scores) {
    const o = teamOrientation(s, game, sportKey);
    if (o === null) continue;
    candidates.push(s);
    if (o === "reversed") reversed.add(s);
  }
  if (candidates.length === 0) return undefined;
  const best = candidates.length === 1 ? candidates[0] : pick(candidates, new Date(game.commenceTime).getTime());
  return reversed.has(best) ? mirrorScoreGame(best) : best;
}
