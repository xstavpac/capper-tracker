// Proof for word-order tolerance on the three single-category yards markets
// (bet-line.ts LEADING_YARDS): "<cat> yards" and "yards <cat>" must resolve
// identically - same propMarket, same extracted player name, same line/side -
// end to end (parsePlayerProp, parseCatalog's classification, the roster
// recovery pass, and the NFL sport-context signal). Run with:
//   npx tsx src/lib/yards-prop-word-order-acceptance-test.ts
//
// Each market is tested independently (not assumed symmetric with passing),
// over AND under, bare surname AND full name. Also pins the no-regression
// cases: combined-category props (incl. the "passing and receiving" typo and
// their own reversed-yards order), receptions, attempts/carries lines never
// gaining a yards reading, and TD props.
import { parsePlayerProp, parsePlayerPropLine, type PlayerPropMarket } from "@/lib/bet-line";
import { parseCatalog, matchingSportsForPickContext } from "@/lib/parse-catalog";
import { recoverUnresolvedLines } from "@/lib/recover-unresolved-lines";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

const mk = (name: string, team: string, position: string) => ({
  playerName: name,
  firstName: name.split(" ")[0],
  lastName: name.split(" ").slice(1).join(" "),
  team,
  position,
  externalPlayerId: name,
});
const roster = [
  mk("Caleb Williams", "Chicago Bears", "QB"),
  mk("Jahmyr Gibbs", "Detroit Lions", "RB"),
  mk("Puka Nacua", "Los Angeles Rams", "WR"),
];

const markets: { word: string; market: PlayerPropMarket; names: [string, string] }[] = [
  { word: "passing", market: "PASS_YDS", names: ["Williams", "Caleb Williams"] },
  { word: "rushing", market: "RUSH_YDS", names: ["Gibbs", "Jahmyr Gibbs"] },
  { word: "receiving", market: "REC_YDS", names: ["Nacua", "Puka Nacua"] },
];

function main() {
  for (const { word, market, names } of markets) {
    for (const side of ["over", "under"] as const) {
      for (const name of names) {
        const normal = `${name} ${side} 65.5 ${word} yards`;
        const reversed = `${name} ${side} 65.5 yards ${word}`;
        const expected = { playerName: name, propMarket: market };
        check(`parsePlayerProp: '${normal}'`, parsePlayerProp(normal), expected);
        check(`parsePlayerProp: '${reversed}' resolves identically`, parsePlayerProp(reversed), expected);
        check(
          `parsePlayerPropLine: '${reversed}' same line/side`,
          parsePlayerPropLine(reversed),
          parsePlayerPropLine(normal)
        );

        const pc = parseCatalog(`Capper\nNFL ${reversed}`, ["Capper"]);
        check(`parseCatalog: 'NFL ${reversed}' -> NFL PLAYER_PROP`, [pc.picks[0]?.sportName, pc.picks[0]?.betType], ["NFL", "PLAYER_PROP"]);

        // Bare line (no sport prefix) goes through roster recovery.
        const bare = parseCatalog(`Capper\n${reversed}`, ["Capper"], roster.map((r) => r.playerName));
        const rec = recoverUnresolvedLines(bare.unresolved, bare.unresolvedCapperNames, [], roster, bare.picks);
        check(`recover: '${reversed}' resolves against roster`, [rec.recovered.length, rec.stillUnresolved.length], [1, 0]);
      }
    }
    check(
      `NFL sport-context signal: 'yards ${word}'`,
      matchingSportsForPickContext(`x over 65.5 yards ${word}`, ["NFL", "MLB"]),
      ["NFL"]
    );
  }

  // Combined markets keep working, and gain the same reversed-yards tolerance.
  check("combined: 'Gibbs Over 99.5 Rushing and Receiving Yards'", parsePlayerProp("Gibbs Over 99.5 Rushing and Receiving Yards"), { playerName: "Gibbs", propMarket: "RUSH_REC_YDS" });
  check("combined: 'Gibbs Over 99.5 Yards Rushing and Receiving'", parsePlayerProp("Gibbs Over 99.5 Yards Rushing and Receiving"), { playerName: "Gibbs", propMarket: "RUSH_REC_YDS" });
  check("combined: 'Allen Over 290.5 Passing + Rushing Yards'", parsePlayerProp("Allen Over 290.5 Passing + Rushing Yards"), { playerName: "Allen", propMarket: "PASS_RUSH_YDS" });
  check("combined: 'Allen Over 249.5 Passing and Receiving Yards' (typo fold-in)", parsePlayerProp("Allen Over 249.5 Passing and Receiving Yards"), { playerName: "Allen", propMarket: "PASS_RUSH_YDS" });
  check("combined: 'Allen Over 249.5 Yards Passing and Receiving' (typo fold-in, reversed)", parsePlayerProp("Allen Over 249.5 Yards Passing and Receiving"), { playerName: "Allen", propMarket: "PASS_RUSH_YDS" });

  // Unchanged neighbours.
  check("receptions unchanged", parsePlayerProp("Nacua over 5.5 receptions"), { playerName: "Nacua", propMarket: "RECEPTIONS" });
  check("'rec yds' unchanged", parsePlayerProp("Nacua over 65.5 rec yds"), { playerName: "Nacua", propMarket: "REC_YDS" });
  check("anytime TD unchanged", parsePlayerProp("Zach Ertz Anytime Touchdown"), { playerName: "Zach Ertz", propMarket: "TD" });
  check("first TD unchanged", parsePlayerProp("Puka Nacua first TD")?.propMarket, "TD");
  // A player-name token that merely resembles the qualifier is never eaten.
  check("name intact when no reversed qualifier", parsePlayerProp("Yards Smith over 65.5 rushing yards")?.playerName, "Yards Smith");

  // Attempts/carries: reversed order must not create a yards reading that
  // wasn't there (they already misread as yards today - see the separate
  // attempts/carries fix - so this only pins that THIS change adds nothing).
  check("'yards rushing attempts' never consumes 'attempts'", parsePlayerProp("Gibbs over 9.5 yards rushing attempts")?.playerName, "Gibbs attempts");
  check("carries line unaffected (still no market)", parsePlayerProp("Gibbs over 9.5 carries"), null);

  console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
