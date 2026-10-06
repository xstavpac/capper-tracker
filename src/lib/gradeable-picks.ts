// Which of the picks a page just loaded can be graded right now - the trigger
// for on-view grading (components/picks/grade-due-picks.tsx).
//
// Grading used to run inside the /picks and /live/[gameId] renders, on every
// view, before anything was drawn. It now runs after paint, and only when this
// says there is something to grade: an ungraded pick, in a sport the app can
// score, whose game is over. "Over" is the same test the ledger's "Grading"
// phase uses (pickPhase in pick-display.ts) - a game_results row already exists
// for the pick's game, or the live feed reports the game final.
//
// A pick that is pending because its game is still live, has not started, or
// is in a sport with no score source is not gradeable and triggers nothing; the
// 15-minute grade-picks cron remains the backstop for everything, including
// picks that are not on screen.
//
// Pure (no imports), so the rule is covered by gradeable-picks-acceptance-test.ts.

export type GradeablePickInput = {
  id: string;
  // The pick's sport as an odds/score sport key, or null when the sport has no
  // score source (never gradeable automatically).
  sportKey: string | null;
  status: string;
  hasFinalResult: boolean;
  feedStatus: "preview" | "live" | "final" | null;
};

export type GradeablePicks = {
  // Distinct sport keys with at least one gradeable pick, in first-seen order.
  sportKeys: string[];
  // Identity of the gradeable set: changes when a pick joins or leaves it, so
  // the client grades again for a new set and not for the same one. Empty
  // string when nothing is gradeable.
  dueKey: string;
};

export function gradeablePicks(picks: GradeablePickInput[]): GradeablePicks {
  const sportKeys: string[] = [];
  const ids: string[] = [];
  for (const p of picks) {
    if (p.status !== "PENDING" || !p.sportKey) continue;
    if (!p.hasFinalResult && p.feedStatus !== "final") continue;
    ids.push(p.id);
    if (!sportKeys.includes(p.sportKey)) sportKeys.push(p.sportKey);
  }
  return { sportKeys, dueKey: ids.length === 0 ? "" : ids.length + ":" + hashIds(ids) };
}

// Order-independent, short, and stable across renders (djb2 over the sorted ids).
function hashIds(ids: string[]): string {
  const joined = [...ids].sort().join(",");
  let h = 5381;
  for (let i = 0; i < joined.length; i++) h = ((h << 5) + h + joined.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
