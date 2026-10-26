// Which league the /live tab opens on when the URL names none (no ?sport=). Pure: the page hands
// it each league's game list from the score feed it already reads (start time and status only).
import { easternDateKey } from "./dates";

export const LIVE_DEFAULT_FALLBACK = "baseball_mlb";

export type LeagueGameStub = { status: "preview" | "live" | "final" | "postponed" | "cancelled"; commenceTime: string };
export type LeagueSlate = { sportKey: string; games: LeagueGameStub[] };

const startMs = (g: LeagueGameStub) => Date.parse(g.commenceTime);

// The league holding the smallest start time among `games`, or null. Ties keep the earlier
// league in `slates` (the tab order).
function earliest(slates: LeagueSlate[], pick: (g: LeagueGameStub) => boolean): string | null {
  let best: { sportKey: string; at: number } | null = null;
  for (const { sportKey, games } of slates) {
    for (const g of games) {
      const at = startMs(g);
      if (Number.isNaN(at) || !pick(g)) continue;
      if (!best || at < best.at) best = { sportKey, at };
    }
  }
  return best?.sportKey ?? null;
}

// 1. A league with a game in progress: the one whose live game started earliest.
// 2. Else the league with the earliest game still to start on today's Eastern date.
// 3. Else (every league is done for today) the league whose next game, on a later Eastern date,
//    starts soonest - only as far ahead as the score feed reaches (tomorrow).
// 4. Else MLB.
// Postponed and cancelled games never count.
export function pickDefaultLeague(slates: LeagueSlate[], now: Date = new Date()): string {
  const today = easternDateKey(now);
  const dayOf = (g: LeagueGameStub) => easternDateKey(new Date(g.commenceTime));
  return (
    earliest(slates, (g) => g.status === "live") ??
    earliest(slates, (g) => g.status === "preview" && dayOf(g) === today) ??
    earliest(slates, (g) => g.status === "preview" && dayOf(g) > today) ??
    LIVE_DEFAULT_FALLBACK
  );
}
