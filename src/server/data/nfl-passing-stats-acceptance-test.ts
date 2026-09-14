// Proof that getNflPlayerTdStats (src/server/data/odds.ts) correctly extracts
// passing-category stats (TD, yards, attempts, completions) from ESPN's NFL
// boxscore.players response, alongside the rushing/receiving TDs it already
// parsed. This is data-extraction proof only - PLAYER_PROP grading
// (resolveTouchdownProp in grading.ts) still ignores these new fields; they
// aren't wired into grading here.
//
// Fixtures are real, unmodified `boxscore.players` payloads pulled from
// ESPN's NFL summary endpoint for three Week 1 2026 games (confirmed FINAL
// at fetch time), saved to __fixtures__/nfl-boxscore-<eventId>-<away>-<home>.json.
// The two teams per fixture were picked to cover:
//   - HOU @ BUF (401872660): the ordinary case, one passer per team.
//   - PIT @ ATL (401872658) and MIN @ GB (401872927): the "second passer"
//     case that's common, not rare - a backup mop-up drive or a trick-play
//     pass from a non-QB (here even a punter) produces a second athlete in
//     the same "passing" category with 0-1 attempts. Real final stat lines
//     for all values below were read directly off ESPN's response before
//     writing this test.
//
// Pure: no network, no database. Listed in PURE_DESPITE_PRISMA_IMPORT is not
// needed (this file never imports @/lib/prisma). Run with:
//   npx tsx src/server/data/nfl-passing-stats-acceptance-test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getNflPlayerTdStats, type NflPlayerTdStats } from "@/server/data/odds";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const FIX = join(__dirname, "__fixtures__");

const realFetch = globalThis.fetch;
function stubFetch(fixtureFile: string) {
  const body = JSON.parse(readFileSync(join(FIX, fixtureFile), "utf8"));
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

function find(stats: NflPlayerTdStats[], name: string): NflPlayerTdStats | undefined {
  return stats.find((s) => s.playerName === name);
}

async function main() {
  // =====================================================================
  // 1. HOU @ BUF (401872660) - one passer per team, the ordinary case.
  // =====================================================================
  stubFetch("nfl-boxscore-401872660-hou-buf.json");
  const houBuf = await getNflPlayerTdStats("401872660");
  restoreFetch();

  const allen = find(houBuf!, "Josh Allen");
  expect("Josh Allen (BUF, Wk1 2026): passCompletions", allen?.passCompletions, 20);
  expect("Josh Allen (BUF, Wk1 2026): passAttempts", allen?.passAttempts, 29);
  expect("Josh Allen (BUF, Wk1 2026): passYards", allen?.passYards, 334);
  expect("Josh Allen (BUF, Wk1 2026): passTds", allen?.passTds, 2);
  // Allen also has 2 rushing TDs in this game - confirms passing extraction
  // didn't clobber the existing rushing/receiving parsing on the same player.
  expect("Josh Allen (BUF, Wk1 2026): rushTds still parses correctly", allen?.rushTds, 2);

  const stroud = find(houBuf!, "C.J. Stroud");
  expect("C.J. Stroud (HOU, Wk1 2026): passCompletions", stroud?.passCompletions, 26);
  expect("C.J. Stroud (HOU, Wk1 2026): passAttempts", stroud?.passAttempts, 38);
  expect("C.J. Stroud (HOU, Wk1 2026): passYards", stroud?.passYards, 274);
  expect("C.J. Stroud (HOU, Wk1 2026): passTds", stroud?.passTds, 2);

  // A player with no passing line at all (pure rusher/receiver) reads 0s,
  // not undefined/NaN - same "present with zeros" convention as rushTds.
  const cook = find(houBuf!, "James Cook III");
  expect("James Cook III (BUF, Wk1 2026): no passing line -> passAttempts 0", cook?.passAttempts, 0);
  expect("James Cook III (BUF, Wk1 2026): no passing line -> passTds 0", cook?.passTds, 0);

  // =====================================================================
  // 2. PIT @ ATL (401872658) - Aaron Rodgers + a second passer (punter
  //    Cameron Johnston, 0/1) in the same "passing" category.
  // =====================================================================
  stubFetch("nfl-boxscore-401872658-pit-atl.json");
  const pitAtl = await getNflPlayerTdStats("401872658");
  restoreFetch();

  const rodgers = find(pitAtl!, "Aaron Rodgers");
  expect("Aaron Rodgers (PIT, Wk1 2026): passCompletions", rodgers?.passCompletions, 24);
  expect("Aaron Rodgers (PIT, Wk1 2026): passAttempts", rodgers?.passAttempts, 40);
  expect("Aaron Rodgers (PIT, Wk1 2026): passYards", rodgers?.passYards, 221);
  expect("Aaron Rodgers (PIT, Wk1 2026): passTds", rodgers?.passTds, 1);

  const johnston = find(pitAtl!, "Cameron Johnston");
  expect(
    "Cameron Johnston (PIT punter, trick-play pass): second passing-category athlete still parses (0/1, 0 yds, 0 TD)",
    { c: johnston?.passCompletions, a: johnston?.passAttempts, y: johnston?.passYards, td: johnston?.passTds },
    { c: 0, a: 1, y: 0, td: 0 }
  );

  // =====================================================================
  // 3. MIN @ GB (401872927) - Carson Wentz + a second passer (Kyler Murray,
  //    3/5) in the same "passing" category.
  // =====================================================================
  stubFetch("nfl-boxscore-401872927-min-gb.json");
  const minGb = await getNflPlayerTdStats("401872927");
  restoreFetch();

  const wentz = find(minGb!, "Carson Wentz");
  expect("Carson Wentz (Wk1 2026): passCompletions", wentz?.passCompletions, 12);
  expect("Carson Wentz (Wk1 2026): passAttempts", wentz?.passAttempts, 19);
  expect("Carson Wentz (Wk1 2026): passYards", wentz?.passYards, 133);
  expect("Carson Wentz (Wk1 2026): passTds", wentz?.passTds, 3);

  const murray = find(minGb!, "Kyler Murray");
  expect(
    "Kyler Murray (second passer, same game): passing line parses independently of Wentz's",
    { c: murray?.passCompletions, a: murray?.passAttempts, y: murray?.passYards, td: murray?.passTds },
    { c: 3, a: 5, y: 18, td: 0 }
  );

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
