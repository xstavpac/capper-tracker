// Proof of dropPhantomCards (the Live board's phantom-card rule): drop a card
// ONLY when it has no schedule-feed game AND a same-teams, same-ET-date sibling
// does. See live-board-dedup.ts.
//
// Run with:
//   npx tsx src/lib/live-board-dedup-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { dropPhantomCards } from "./live-board-dedup";
import type { ScoreGame } from "@/server/data/odds";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const PHI = "Philadelphia Phillies";
const ATL = "Atlanta Braves";

const card = (id: string, home: string, away: string, commenceTime: string) => ({
  id,
  homeTeam: home,
  awayTeam: away,
  commenceTime,
});
const sched = (
  id: string,
  home: string,
  away: string,
  commenceTime: string,
  extra: Partial<ScoreGame> = {}
): ScoreGame => ({
  id,
  homeTeam: home,
  awayTeam: away,
  commenceTime,
  status: "preview",
  scores: null,
  inningHalf: null,
  inningOrdinal: null,
  innings: null,
  ...extra,
});
const ids = (r: { games: { id: string }[] }) => r.games.map((g) => g.id);

// ---- 1. The 2026-10-01 phantom ------------------------------------------------
// Real MLB schedule (fetched 2026-10-01): Sep 30 18:00Z Final, Oct 1 game at
// 2026-10-02T00:00Z (7:00 PM CDT), doubleHeader "N". The Odds API snapshot had a
// 1:00 PM CDT (18:00Z Oct 1) event next to the real 7:11 PM CDT one.
const sep30 = sched("849841", ATL, PHI, "2026-09-30T18:00:00Z", { status: "final", gameNumber: 1, doubleHeaderStatus: "N" });
const oct1 = sched("849844", ATL, PHI, "2026-10-02T00:00:00Z", { gameNumber: 1, doubleHeaderStatus: "N" });
const phantom = card("phantom-1pm", ATL, PHI, "2026-10-01T18:00:00Z");
const real = card("real-711pm", ATL, PHI, "2026-10-02T00:11:00Z");

const r1 = dropPhantomCards([phantom, real], [sep30, oct1]);
expect("1a. phantom dropped, real kept", ids(r1), ["real-711pm"]);
expect("1b. kept card is assigned the real schedule game", r1.scheduleGames.map((s) => s?.id), ["849844"]);
expect("1c. order of the input list does not matter", ids(dropPhantomCards([real, phantom], [oct1, sep30])), ["real-711pm"]);
expect(
  "1d. yesterday's Final game can't rescue the phantom (different ET date, never claimable)",
  ids(dropPhantomCards([phantom, real], [sep30, oct1])).includes("phantom-1pm"),
  false
);

// ---- 2. A real doubleheader keeps both cards -----------------------------------
const dh1 = sched("dh1", "Chicago Cubs", "St. Louis Cardinals", "2026-09-20T17:05:00Z", { gameNumber: 1, doubleHeaderStatus: "Y" });
const dh2 = sched("dh2", "Chicago Cubs", "St. Louis Cardinals", "2026-09-20T20:35:00Z", { gameNumber: 2, doubleHeaderStatus: "Y" });
const c1 = card("c1", "Chicago Cubs", "St. Louis Cardinals", "2026-09-20T17:05:00Z");
const c2 = card("c2", "Chicago Cubs", "St. Louis Cardinals", "2026-09-20T20:35:00Z");
const r2 = dropPhantomCards([c1, c2], [dh1, dh2]);
expect("2a. both doubleheader cards kept", ids(r2), ["c1", "c2"]);
expect("2b. each card gets its own leg", r2.scheduleGames.map((s) => s?.gameNumber), [1, 2]);

// Traditional doubleheader: game 2's listed start is a placeholder minutes after
// game 1 - both cards sit nearer game 1 in time, yet each still needs its own leg.
const dh2Placeholder = sched("dh2p", "Chicago Cubs", "St. Louis Cardinals", "2026-09-20T17:20:00Z", { gameNumber: 2, doubleHeaderStatus: "Y" });
const c2Placeholder = card("c2p", "Chicago Cubs", "St. Louis Cardinals", "2026-09-20T17:20:00Z");
const r2c = dropPhantomCards([c1, c2Placeholder], [dh1, dh2Placeholder]);
expect("2c. placeholder-time doubleheader: both kept", ids(r2c), ["c1", "c2p"]);
expect("2d. ...and each is assigned a different leg", r2c.scheduleGames.map((s) => s?.gameNumber), [1, 2]);

// ---- 3. Cases where nothing may be dropped -------------------------------------
expect("3a. empty schedule feed -> nothing dropped", ids(dropPhantomCards([phantom, real], [])), ["phantom-1pm", "real-711pm"]);
expect(
  "3b. schedule game under a different team spelling -> nothing dropped (no sibling matches)",
  ids(dropPhantomCards([phantom, real], [sched("x", "Atlanta Braves Club", PHI, "2026-10-02T00:00:00Z")])),
  ["phantom-1pm", "real-711pm"]
);
expect("3c. a lone card with no schedule game is kept", ids(dropPhantomCards([phantom], [sep30])), ["phantom-1pm"]);
expect(
  "3d. two cards, neither matched (date past the feed window) -> both kept",
  ids(dropPhantomCards([card("a", ATL, PHI, "2026-10-05T18:00:00Z"), card("b", ATL, PHI, "2026-10-05T23:00:00Z")], [oct1])),
  ["a", "b"]
);
expect(
  "3e. other matchups on the board are untouched",
  ids(dropPhantomCards([card("o", "New York Mets", "Miami Marlins", "2026-10-01T23:00:00Z"), phantom, real], [oct1])),
  ["o", "real-711pm"]
);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
if (failures > 0) process.exit(1);
