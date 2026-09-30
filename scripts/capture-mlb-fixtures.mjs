// Captures REAL MLB Stats API responses as test fixtures, reduced to the fields the extractors read
// (box scores drop seasonStats/gameStatus/etc.; rosters keep person id/names + position). Run by hand:
//
//   node scripts/capture-mlb-fixtures.mjs boxscore 849845 atl-phi-wc
//   node scripts/capture-mlb-fixtures.mjs roster 119,133,144 mlb-roster-sample
//
// Writes src/server/data/__fixtures__/mlb-<kind>-<pk|name>.json. Tests never hit the network.
import { writeFileSync } from "node:fs";

const [kind, arg, label] = process.argv.slice(2);
const dir = new URL("../src/server/data/__fixtures__/", import.meta.url);
const get = async (u) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(u + " -> " + r.status);
  return r.json();
};

if (kind === "boxscore") {
  const b = await get(`https://statsapi.mlb.com/api/v1/game/${arg}/boxscore`);
  const keepBat = ["atBats", "plateAppearances", "hits", "doubles", "triples", "homeRuns", "totalBases", "baseOnBalls", "runs", "rbi"];
  const keepPit = ["outs", "strikeOuts", "gamesStarted", "inningsPitched"];
  const pick = (o, keys) => (o && Object.keys(o).length ? Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])) : {});
  const teams = {};
  for (const side of ["home", "away"]) {
    const t = b.teams[side];
    teams[side] = {
      team: { id: t.team.id, name: t.team.name },
      players: Object.fromEntries(
        Object.entries(t.players).map(([k, p]) => [
          k,
          {
            person: { id: p.person.id, fullName: p.person.fullName },
            position: { abbreviation: p.position?.abbreviation },
            stats: { batting: pick(p.stats.batting, keepBat), pitching: pick(p.stats.pitching, keepPit) },
          },
        ])
      ),
    };
  }
  writeFileSync(new URL(`mlb-boxscore-${arg}-${label ?? "game"}.json`, dir), JSON.stringify({ teams }));
} else if (kind === "roster") {
  const out = {};
  for (const id of arg.split(",")) {
    const r = await get(`https://statsapi.mlb.com/api/v1/teams/${id}/roster?rosterType=40Man&season=2026&hydrate=person`);
    out[id] = {
      roster: r.roster.map((x) => ({
        person: { id: x.person.id, fullName: x.person.fullName, firstName: x.person.firstName, lastName: x.person.lastName, useName: x.person.useName },
        position: { abbreviation: x.position.abbreviation },
      })),
    };
  }
  writeFileSync(new URL(`mlb-roster-${label ?? "sample"}.json`, dir), JSON.stringify(out));
} else {
  console.error("usage: boxscore <gamePk> [label] | roster <teamId,teamId,..> [label]");
  process.exit(1);
}
