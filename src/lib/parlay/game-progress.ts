// How far along a started game is, and whether the Parlay Generator may still
// build from it. A game that has kicked off is not dropped from the pool: it
// stays eligible until it passes its sport's progress cutoff.
//
//   NBA, WNBA, NFL, NCAAF  until Q3 has ended  (Q1-Q3 in play; "End Q3", Q4 and OT out)
//   NCAAB                  until 1H has ended  (1H in play; halftime, 2H and OT out)
//   NHL                    until P2 has ended  (P1-P2 in play; 2nd intermission, P3, OT and shootout out)
//   MLB                    through the 6th inning  (inning <= 6; "End 6th" is in, "Top 7th" is out)
//
// A period-based cutoff period has ended when the feed's clock for it reads 0
// ("0:00" / "0.0": ESPN's end-of-period, intermission and halftime state), so
// the break after it is out, not in.
//
// Backstop: whatever the feed says, a started game is out once its scheduled
// start is further back than its sport's backstopMin (a little past when the
// cutoff is normally reached). A stale or stuck feed read - a game still
// "preview" (delayed start) or still "live P1" hours after it began - cannot
// keep it in the pool indefinitely.
//
// A started game with no usable progress (no feed row, feed live with no
// period/inning, a league with no cutoff) is NOT eligible. Final, postponed and
// cancelled go by game-over.ts and are never eligible. A game the feed still
// calls "preview" after its scheduled start (delayed start / warmup) has not
// progressed at all, so it stays eligible - until the backstop.
//
// The price shown for a started game is still the pregame snapshot price.
// startedPriceLabel says what that price is: an estimate while the score is
// unchanged (0-0, score present), otherwise just the pregame line (live pricing
// is not built yet). A missing score counts as changed, never as 0-0.
//
// Pure and client-safe: the state arrives from the cached score feed with the
// snapshot (server/data/live-state.ts); nothing here reads a database.
import { hasKickedOff, isGameOver, type GameClock } from "@/lib/parlay/game-over";

// A started game's progress and score, as the score feed reported it when the
// pool (or the slip check) was read. Scores are away/home to match "Away @ Home".
export type GameLiveState = {
  // ESPN-backed leagues: quarter / half / period, 1-based (> regulation in OT).
  period: number | null;
  // ESPN's display clock for that period ("4:12", "0.0").
  clock: string | null;
  // MLB: "Top" / "Bottom" / "Middle" / "End" and the inning number.
  inningHalf: string | null;
  inning: number | null;
  away: number | null;
  home: number | null;
  // The feed left out at least one side's score (it would display as 0).
  scoreMissing: boolean;
};

// stateUnavailable: the score feed could not be read fresh enough for this build
// (server/data/fresh-live-scores.ts). The game is then judged by time since its
// scheduled start alone (the backstop), never by an old status or state.
export type LiveClock = GameClock & { leagueName: string; liveState?: GameLiveState | null; stateUnavailable?: boolean };

// backstopMin: minutes after the SCHEDULED start past which a started game is
// out whatever the feed says. Each is a little later than the cutoff is
// normally reached (the scheduled-to-actual start delay included), so a fresh
// feed still decides an ordinary game; a long one may drop a few minutes early.
//   NBA   Q3 ends ~115 min in -> 125     WNBA  ~100 -> 110
//   NFL   Q3 ends ~155 min in -> 165     NCAAF ~170 -> 180
//   NCAAB 1H ends ~50-55 in   ->  65     NHL   P2 ends ~100 -> 110
//   MLB   6th ends ~115 in    -> 130
type Cutoff = { unit: "period" | "inning"; max: number; backstopMin: number };

export const PROGRESS_CUTOFFS: Record<string, Cutoff> = {
  NBA: { unit: "period", max: 3, backstopMin: 125 },
  WNBA: { unit: "period", max: 3, backstopMin: 110 },
  NFL: { unit: "period", max: 3, backstopMin: 165 },
  NCAAF: { unit: "period", max: 3, backstopMin: 180 },
  NCAAB: { unit: "period", max: 1, backstopMin: 65 },
  NHL: { unit: "period", max: 2, backstopMin: 110 },
  MLB: { unit: "inning", max: 6, backstopMin: 130 },
};

// A league with no cutoff: only a delayed start ("preview") can be eligible, and only this long.
export const DEFAULT_BACKSTOP_MIN = 60;

// Kicked off more than the league's backstop ago. An unparseable start counts as past it.
export function pastBackstop(leagueName: string, gameTime: string, now: Date): boolean {
  const start = new Date(gameTime).getTime();
  const minutes = PROGRESS_CUTOFFS[leagueName]?.backstopMin ?? DEFAULT_BACKSTOP_MIN;
  return !Number.isFinite(start) || now.getTime() - start > minutes * 60_000;
}

// "5th" -> 5. Null for anything without a leading number.
export function inningNumber(ordinal: string | null | undefined): number | null {
  const m = /^\s*(\d+)/.exec(ordinal ?? "");
  return m ? Number(m[1]) : null;
}

// Within the league's cutoff, judged on progress alone. Unknown progress, or a
// league with no cutoff, is outside. For a period cutoff, the cutoff period
// itself is in only while its clock runs: at 0 it has ended (end of period /
// intermission / halftime), which is out.
export function withinProgressCutoff(leagueName: string, state: GameLiveState | null | undefined): boolean {
  const cutoff = PROGRESS_CUTOFFS[leagueName];
  if (!cutoff || !state) return false;
  const at = cutoff.unit === "period" ? state.period : state.inning;
  if (typeof at !== "number" || !Number.isFinite(at) || at < 1 || at > cutoff.max) return false;
  return !(cutoff.unit === "period" && at === cutoff.max && periodEnded(state.clock));
}

// May the generator build from this game right now? Not started: yes. Over: no.
// Started: past the league's backstop no, whatever the feed says; with no fresh
// feed read (stateUnavailable) yes, up to the backstop; otherwise a delayed start
// ("preview") yes; live within the cutoff yes; anything else no.
export function poolEligible(game: LiveClock, now: Date): boolean {
  if (isGameOver(game, now)) return false;
  if (!hasKickedOff(game.gameTime, now)) return true;
  if (pastBackstop(game.leagueName, game.gameTime, now)) return false;
  if (game.stateUnavailable) return true;
  if (game.gameStatus === "preview") return true;
  if (game.gameStatus !== "live") return false;
  return withinProgressCutoff(game.leagueName, game.liveState);
}

// A copy of `pick` carrying its game's state; never changes `pick` (whose odds
// stay exactly as stored). With no state, a pick that carries none comes back as is.
export function withLiveState<T extends { liveState?: GameLiveState | null }>(pick: T, state: GameLiveState | null): T {
  if (state === null && pick.liveState == null) return pick;
  return { ...pick, liveState: state };
}

// Started and not over: the games that get a state line and a price label.
export function isStarted(game: GameClock, now: Date): boolean {
  return hasKickedOff(game.gameTime, now) && !isGameOver(game, now);
}

const END_OF_PERIOD = /^0(?::00|\.0+)?$/;

// The feed's clock for the current period has run out: "0:00", "0.0", "0".
function periodEnded(clock: string | null): boolean {
  return clock !== null && END_OF_PERIOD.test(clock.trim());
}
const QUARTER_LEAGUES = new Set(["NBA", "WNBA", "NFL", "NCAAF"]);

function overtime(n: number): string {
  return n <= 1 ? "OT" : n + "OT";
}

// "Q2 4:12", "Half", "End Q3", "1H 8:40", "P2 5:01", "OT", "Top 5th".
export function progressText(leagueName: string, state: GameLiveState): string | null {
  if (leagueName === "MLB") {
    if (state.inning === null) return null;
    const ord = ordinal(state.inning);
    return state.inningHalf ? state.inningHalf + " " + ord : ord;
  }
  const p = state.period;
  if (p === null || !Number.isFinite(p) || p < 1) return null;
  const ended = state.clock !== null && END_OF_PERIOD.test(state.clock.trim());
  const clock = state.clock && !ended ? " " + state.clock.trim() : "";
  if (QUARTER_LEAGUES.has(leagueName)) {
    if (p > 4) return overtime(p - 4) + (ended ? "" : clock);
    if (ended) return p === 2 ? "Half" : "End Q" + p;
    return "Q" + p + clock;
  }
  if (leagueName === "NCAAB") {
    if (p > 2) return overtime(p - 2) + (ended ? "" : clock);
    if (ended) return p === 1 ? "Half" : "End 2H";
    return p + "H" + clock;
  }
  if (leagueName === "NHL") {
    if (p > 3) return overtime(p - 3) + (ended ? "" : clock);
    if (ended) return "End P" + p;
    return "P" + p + clock;
  }
  return "Period " + p + clock;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return n + "th";
  return n + (["th", "st", "nd", "rd"][n % 10] ?? "th");
}

const scoreKnown = (s: GameLiveState) => !s.scoreMissing && s.away !== null && s.home !== null;

// "Started · Q2 4:12 · 45-41" (away-home, like "Away @ Home"); "Started · Top 5th · 2-1" for MLB.
// Only the parts the feed gave: "Started" alone when nothing is known.
export function startedStateLine(leagueName: string, state: GameLiveState | null | undefined): string {
  const parts = ["Started"];
  if (state) {
    const progress = progressText(leagueName, state);
    if (progress) parts.push(progress);
    if (scoreKnown(state)) parts.push(state.away + "-" + state.home);
  }
  return parts.join(" · ");
}

export const PRICE_EST_UNCHANGED = "est. · score unchanged";
export const PRICE_PREGAME_LINE = "pregame line";
// A started game's leg that has FanDuel's in-play price (live-price.ts): the price shown is that one.
export const PRICE_LIVE = "live price";

// What the pregame price on a started game is. "unchanged" only on a present 0-0
// (or a delayed start the feed still calls preview); a missing score is "changed".
export function startedPriceKind(game: { gameStatus?: GameClock["gameStatus"]; liveState?: GameLiveState | null }): "unchanged" | "changed" {
  if (game.gameStatus === "preview") return "unchanged";
  const s = game.liveState;
  if (!s || !scoreKnown(s)) return "changed";
  return s.away === 0 && s.home === 0 ? "unchanged" : "changed";
}

export function startedPriceLabel(game: { gameStatus?: GameClock["gameStatus"]; liveState?: GameLiveState | null }): string {
  return startedPriceKind(game) === "unchanged" ? PRICE_EST_UNCHANGED : PRICE_PREGAME_LINE;
}
