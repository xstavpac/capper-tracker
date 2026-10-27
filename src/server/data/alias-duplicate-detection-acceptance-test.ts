// Does storing the roster name on an alias hit break "this pick is already logged"? Run with:
//   npx tsx src/server/data/alias-duplicate-detection-acceptance-test.ts
// Pure: no database. Uses the real identity code behind the check that decides what is inserted
// (insertPicksDeduped, server/data/pick-dedup.ts): a queued row is read by rowBetIdentity, a logged
// pick by existingBetIdentity, and the two are compared by isSameBet. What identifies a prop there is
// the market plus the player's name, lower-cased - the stored playerName column of a logged pick,
// and the name parsed from the new row's text.
import { parseAnyPlayerProp } from "@/lib/bet-line";
import { isSameBet } from "@/lib/duplicate-pick-detection";
import { existingBetIdentity, type ExistingPickRow } from "@/server/data/duplicate-db-match";
import { rowBetIdentity, sportKeyForName, type DedupPickRow } from "@/server/data/pick-dedup";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const DRIFT = 6 * 3600_000;
const T0 = new Date(Date.UTC(2026, 9, 28, 23, 0, 0));
const GAME = { homeTeam: "Atlanta Hawks", awayTeam: "Oklahoma City Thunder" };

// A logged NBA prop as the importer stores it: betDetail = the stored text, playerName/propMarket parsed from it.
function logged(betDetail: string, sport = "NBA"): ExistingPickRow {
  const parsed = parseAnyPlayerProp(betDetail, sport)!;
  return {
    id: "logged", capperId: "c1", sportId: "nba", ...GAME, gameTime: T0, period: "FULL_GAME", betType: "PLAYER_PROP", betDetail,
    odds: -110, line: 30.5, pickedSide: null, mlFavoredSide: null, propMarket: parsed.propMarket as ExistingPickRow["propMarket"], playerName: parsed.playerName,
  };
}
// A row about to be inserted, built as bulkImportPicksAction builds it (propMarket / playerName from the text).
function queued(description: string, sport = "NBA"): DedupPickRow {
  const parsed = parseAnyPlayerProp(description, sport)!;
  return {
    sportName: sport, betType: "PLAYER_PROP", betDetail: description, period: "FULL_GAME", odds: -110, line: 30.5, ...GAME, gameTime: T0,
    pickedSide: null, mlFavoredSide: null, propMarket: parsed.propMarket, playerName: parsed.playerName,
  } as unknown as DedupPickRow;
}
const isDuplicate = (log: ExistingPickRow, description: string, sport = "NBA") =>
  isSameBet(existingBetIdentity(log, sport, sportKeyForName(sport)), rowBetIdentity(queued(description, sport)), DRIFT);

const OLD_SGA = logged("SGA over 30.5 points"); // stored before the alias change
const OLD_EMBIID = logged("Embiid P+R over 40.5");
const NEW_SGA = logged("Shai Gilgeous-Alexander over 30.5 points"); // stored after it

console.log("stored playerName columns:", [OLD_SGA.playerName, OLD_EMBIID.playerName, NEW_SGA.playerName]);
console.log("\n### control: the check works when both sides read the same name");
check("old 'SGA' row + a paste that still reads 'SGA'", isDuplicate(OLD_SGA, "SGA over 30.5 points"), true);
check("new full-name row + the same full-name paste", isDuplicate(NEW_SGA, "Shai Gilgeous-Alexander over 30.5 points"), true);
check("a different player is not a duplicate", isDuplicate(NEW_SGA, "Jalen Williams over 30.5 points"), false);
check("a different market is not a duplicate", isDuplicate(NEW_SGA, "Shai Gilgeous-Alexander over 5.5 rebounds"), false);

console.log("\n### the question: logged BEFORE the change, pasted again AFTER it");
check("old 'SGA over 30.5 points' + new paste 'Shai Gilgeous-Alexander over 30.5 points'", isDuplicate(OLD_SGA, "Shai Gilgeous-Alexander over 30.5 points"), true);
check("old 'Embiid P+R over 40.5' + new paste 'Joel Embiid P+R over 40.5'", isDuplicate(OLD_EMBIID, "Joel Embiid P+R over 40.5"), true);

console.log("\n### aliases map in the dedup key, on both sides, by the pick's own sport");
check("old 'KAT' row + new full-name paste", isDuplicate(logged("KAT over 22.5 rebounds"), "Karl-Anthony Towns over 22.5 rebounds"), true);
check("new full-name row + a paste still written 'KAT' (alias on the new side)", isDuplicate(NEW_SGA, "SGA over 30.5 points"), true);
check("alias vs alias ('SGA' row, 'Shai' paste)", isDuplicate(OLD_SGA, "Shai over 30.5 points"), true);
check("'PG13' row + 'Paul George' paste", isDuplicate(logged("PG13 over 20.5 points"), "Paul George over 20.5 points"), true);
check("punctuation/case does not tell spellings apart (full name vs full name)", isDuplicate(logged("shai gilgeous alexander over 30.5 points"), "Shai Gilgeous-Alexander over 30.5 points"), true);
const OLD_CMC = logged("CMC over 80.5 rushing yards", "NFL");
check("NFL: 'CMC' row + 'Christian McCaffrey' paste", isDuplicate(OLD_CMC, "Christian McCaffrey over 80.5 rushing yards", "NFL"), true);
check("NFL: a bare 'McCaffrey' is NOT canonicalized (out of scope)", isDuplicate(OLD_CMC, "McCaffrey over 80.5 rushing yards", "NFL"), false);
check("NFL: Luke McCaffrey is not Christian", isDuplicate(OLD_CMC, "Luke McCaffrey over 80.5 rushing yards", "NFL"), false);

console.log("\n### scope: an alias only maps in its own league");
check("NHL 'SGA' row + the NBA full name: not mapped (NHL pick)", isDuplicate(logged("SGA over 1.5 points", "NHL"), "Shai Gilgeous-Alexander over 1.5 points", "NHL"), false);
check("NHL 'SGA' row + NHL 'SGA' paste: still the same bet", isDuplicate(logged("SGA over 1.5 points", "NHL"), "SGA over 1.5 points", "NHL"), true);
check("NFL 'KD' does not map to Kevin Durant", isDuplicate(logged("KD over 80.5 rushing yards", "NFL"), "Kevin Durant over 80.5 rushing yards", "NFL"), false);
check("NBA 'CMC' does not map to Christian McCaffrey", isDuplicate(logged("CMC over 20.5 points"), "Christian McCaffrey over 20.5 points"), false);
check("NBA full-name row is never merged with the NFL alias table", isDuplicate(logged("Christian McCaffrey over 20.5 points"), "CMC over 20.5 points"), false);

console.log("\n### no new cross-player false matches");
check("'Luka' (Doncic) is not Luka Garza", isDuplicate(logged("Luka over 8.5 assists"), "Luka Garza over 8.5 assists"), false);
check("'Luka' (Doncic) is Luka Doncic", isDuplicate(logged("Luka over 8.5 assists"), "Luka Doncic over 8.5 assists"), true);
check("'JDub' (Jalen Williams) is not Jaylin Williams", isDuplicate(logged("JDub over 20.5 points"), "Jaylin Williams over 20.5 points"), false);
check("'AD' is not Anthony Edwards", isDuplicate(logged("AD over 24.5 points"), "Anthony Edwards over 24.5 points"), false);
check("an alias on a different market is a different bet", isDuplicate(OLD_SGA, "Shai Gilgeous-Alexander over 5.5 rebounds"), false);
check("an alias in a different period is a different bet", isSameBet(existingBetIdentity(OLD_SGA, "NBA", sportKeyForName("NBA")), rowBetIdentity({ ...queued("Shai Gilgeous-Alexander over 30.5 points"), period: "FIRST_HALF" } as DedupPickRow), DRIFT), false);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
