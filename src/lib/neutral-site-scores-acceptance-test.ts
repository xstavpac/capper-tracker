// Live scores must attach to a neutral-site card whichever team the score feed calls home -
// run with:
//   npx tsx src/lib/neutral-site-scores-acceptance-test.ts
//
// Auburn / Notre Dame 2026-11-19 (Michelob ULTRA Arena): ESPN home = Auburn, the Odds API card
// home = Notre Dame. matchScoreToGame required home-to-home, so the card got no score. Both
// copies (server odds.ts, client live-scoreboard-ordering.ts) are checked, and against each other.

import { matchScoreToGame as serverMatch } from "@/server/data/odds";
import type { ScoreGame } from "@/server/data/odds";
import { matchScoreToGame as clientMatch, teamScore } from "@/components/live/live-scoreboard-ordering";
import { scoreLogos } from "@/lib/team-logo";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const T = "2026-11-19T22:00:00Z";
const NCAAB = "basketball_ncaab";
const feed: ScoreGame = {
  id: "espn-1",
  homeTeam: "Auburn Tigers",
  awayTeam: "Notre Dame Fighting Irish",
  status: "live",
  scores: [
    { name: "Auburn Tigers", score: "41" },
    { name: "Notre Dame Fighting Irish", score: "38" },
  ],
  commenceTime: T,
  inningHalf: null,
  inningOrdinal: null,
  innings: null,
  homeLogoUrl: "auburn.png",
  awayLogoUrl: "nd.png",
};
const ndHomeCard = { homeTeam: "Notre Dame Fighting Irish", awayTeam: "Auburn Tigers", commenceTime: T };
const auburnHomeCard = { homeTeam: "Auburn Tigers", awayTeam: "Notre Dame Fighting Irish", commenceTime: T };

const copies: [string, typeof serverMatch][] = [
  ["server", serverMatch],
  ["client", clientMatch],
];
for (const [label, match] of copies) {
  const s = match([feed], ndHomeCard, NCAAB);
  check(`${label}: flipped feed attaches to the card`, s?.id, "espn-1");
  check(`${label}: each team keeps its own score`, [teamScore(s, ndHomeCard.homeTeam, NCAAB), teamScore(s, ndHomeCard.awayTeam, NCAAB)], ["38", "41"]);
  check(`${label}: returned in the card orientation`, [s?.homeTeam, s?.awayTeam], ["Notre Dame Fighting Irish", "Auburn Tigers"]);
  check(`${label}: logos follow the teams`, scoreLogos(s), { home: "nd.png", away: "auburn.png" });
  check(`${label}: status survives`, s?.status, "live");
  const same = match([feed], auburnHomeCard, NCAAB);
  check(`${label}: same orientation returns the feed object untouched`, same === feed, true);
  check(`${label}: other teams -> no match`, match([feed], { ...ndHomeCard, awayTeam: "Duke Blue Devils" }, NCAAB), undefined);
}
check("mirror is stable per feed game", serverMatch([feed], ndHomeCard, NCAAB) === serverMatch([feed], ndHomeCard, NCAAB), true);

// MLB innings are home/away relative: mirrored with the teams.
const mlb: ScoreGame = {
  id: "mlb-1",
  homeTeam: "A",
  awayTeam: "B",
  status: "final",
  scores: [
    { name: "A", score: "3" },
    { name: "B", score: "2" },
  ],
  commenceTime: T,
  inningHalf: null,
  inningOrdinal: null,
  innings: [{ num: 1, home: { runs: 3 }, away: { runs: 2 } }],
};
check("innings swap with the teams", serverMatch([mlb], { homeTeam: "B", awayTeam: "A", commenceTime: T })?.innings, [{ num: 1, home: { runs: 2 }, away: { runs: 3 } }]);

// Nearest start still decides between candidates in mixed orientations.
const early: ScoreGame = { ...feed, id: "early", commenceTime: "2026-11-19T12:00:00Z" };
const late: ScoreGame = { ...feed, id: "late", homeTeam: "Notre Dame Fighting Irish", awayTeam: "Auburn Tigers", commenceTime: "2026-11-19T22:05:00Z" };
check("closest start wins across orientations (server and client agree)", [serverMatch([early, late], ndHomeCard, NCAAB)?.id, clientMatch([early, late], ndHomeCard, NCAAB)?.id], ["late", "late"]);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll passed");
