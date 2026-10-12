// The pure half of the server-side duplicate fix: the one "same bet" rule, the
// review screen's check gate, the fuzzy-capper name fix, and a guard that every
// Pick insert goes through the server-side check.
//
// Pure - no database. Run with:
//   npx tsx src/lib/duplicate-check-gate-acceptance-test.ts
// Exits non-zero on any failed assertion.
//
// "LEGACY reproduces" lines run the rule this replaced and PASS when it gives
// the wrong answer, so the bug is shown rather than assumed.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  computeDuplicateFlags,
  duplicateCheckBlocksImport,
  duplicateCheckStatus,
  isComparableBet,
  isSameBet,
  resolveCapperName,
  withTimeout,
  type BetIdentity,
  type ResolvedDupCandidate,
} from "@/lib/duplicate-pick-detection";
import { mergeDuplicateHeadline, mergeDuplicateLines } from "@/lib/merge-duplicate-report";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const DRIFT = 6 * 3600_000;
const T0 = Date.UTC(2026, 9, 10, 1, 0, 0);

function bet(over: Partial<BetIdentity> = {}): BetIdentity {
  return {
    homeTeam: "Air Force Falcons",
    awayTeam: "Wyoming Cowboys",
    gameTimeMs: T0,
    sportKey: "americanfootball_ncaaf",
    period: "FULL_GAME",
    betType: "SPREAD",
    category: "SPREAD_PLUS",
    pickedSide: "AWAY",
    ...over,
  };
}

// LEGACY: the comparison computeDuplicateFlags / dbDuplicateLabel used to make.
function legacySameBet(a: BetIdentity, b: BetIdentity): boolean {
  return (
    a.category !== null &&
    a.category === b.category &&
    a.period === b.period &&
    a.homeTeam === b.homeTeam &&
    a.awayTeam === b.awayTeam &&
    Math.abs(a.gameTimeMs - b.gameTimeMs) <= DRIFT
  );
}

async function main() {
  // ---- isSameBet ----
  check("same game, same side-aware category is the same bet", isSameBet(bet(), bet(), DRIFT));
  check("the other side of the spread is not", !isSameBet(bet(), bet({ category: "SPREAD_MINUS", pickedSide: "HOME" }), DRIFT));
  check("another game segment is not", !isSameBet(bet(), bet({ period: "FIRST_HALF" }), DRIFT));
  check("a game 6h01m away is not", !isSameBet(bet(), bet({ gameTimeMs: T0 + DRIFT + 60_000 }), DRIFT));
  check("a game 6h away is", isSameBet(bet(), bet({ gameTimeMs: T0 + DRIFT }), DRIFT));
  check("home and away swapped is not the same game", !isSameBet(bet(), bet({ homeTeam: "Wyoming Cowboys", awayTeam: "Air Force Falcons" }), DRIFT));

  // Score-feed spelling vs Odds API spelling.
  const espn = bet({ homeTeam: "Hawai'i Rainbow Warriors", awayTeam: "App State Mountaineers" });
  const oddsApi = bet({ homeTeam: "Hawaii Rainbow Warriors", awayTeam: "Appalachian State Mountaineers" });
  check("LEGACY reproduces: exact strings miss the Odds API spelling", !legacySameBet(espn, oddsApi));
  check("the two feeds' spellings are the same game", isSameBet(espn, oddsApi, DRIFT) && isSameBet(oddsApi, espn, DRIFT));
  check("aliases are per league: no NCAAF alias under the NBA key", !isSameBet({ ...espn, sportKey: "basketball_nba" }, { ...oddsApi, sportKey: "basketball_nba" }, DRIFT));
  check("an alias never joins a different team", !isSameBet(espn, bet({ homeTeam: "Louisiana Tech Bulldogs", awayTeam: "Appalachian State Mountaineers" }), DRIFT));
  check(
    "accent / St. folding needs no sport key",
    isSameBet(
      bet({ sportKey: undefined, homeTeam: "Montréal Canadiens", awayTeam: "St. Louis Blues" }),
      bet({ sportKey: undefined, homeTeam: "Montreal Canadiens", awayTeam: "St Louis Blues" }),
      DRIFT
    )
  );

  // Moneyline: the picked team, not favourite/underdog.
  const favorite = bet({ betType: "MONEYLINE", category: "FAV_ML", pickedSide: "HOME" });
  const flipped = bet({ betType: "MONEYLINE", category: "DOG_ML", pickedSide: "HOME" });
  check("LEGACY reproduces: FAV_ML vs DOG_ML hides a flipped moneyline", !legacySameBet(favorite, flipped));
  check("a moneyline that flipped favourite -> underdog is the same bet", isSameBet(favorite, flipped, DRIFT));
  check(
    "LEGACY reproduces: both sides of a pick'em classify alike",
    legacySameBet(favorite, bet({ betType: "MONEYLINE", category: "FAV_ML", pickedSide: "AWAY" }))
  );
  check("the other team's moneyline is a different bet", !isSameBet(favorite, bet({ betType: "MONEYLINE", category: "FAV_ML", pickedSide: "AWAY" }), DRIFT));
  check(
    "a moneyline with no known picked team falls back to the category",
    isSameBet(favorite, bet({ betType: "MONEYLINE", category: "FAV_ML", pickedSide: null }), DRIFT) &&
      !isSameBet(favorite, bet({ betType: "MONEYLINE", category: "DOG_ML", pickedSide: null }), DRIFT)
  );
  check("a moneyline with a picked team is comparable without a category", isComparableBet({ betType: "MONEYLINE", category: null, pickedSide: "HOME" }));
  check("a total with no over/under is not comparable", !isComparableBet({ betType: "TOTAL", category: null, pickedSide: null }));
  check("two uncomparable bets are never the same bet", !isSameBet(bet({ betType: "TOTAL", category: null }), bet({ betType: "TOTAL", category: null }), DRIFT));

  // ---- the preview uses the same rule within a paste ----
  const cand = (index: number, over: Partial<ResolvedDupCandidate>): ResolvedDupCandidate => ({
    index,
    capperKey: "c1",
    capperName: "Feed Capper",
    homeTeam: espn.homeTeam,
    awayTeam: espn.awayTeam,
    gameTimeMs: T0,
    category: "OVER",
    period: "FULL_GAME",
    description: "Over 51.5",
    dbDuplicateLabel: null,
    sportKey: "americanfootball_ncaaf",
    betType: "TOTAL",
    pickedSide: null,
    ...over,
  });
  const flags = computeDuplicateFlags(
    [cand(0, {}), cand(1, { homeTeam: oddsApi.homeTeam, awayTeam: oddsApi.awayTeam }), cand(2, { capperKey: "c2" })],
    DRIFT
  );
  check("preview: the cross-spelling copy in one paste is flagged, another capper's is not", Object.keys(flags).join(",") === "1", Object.keys(flags).join(","));
  const mlFlags = computeDuplicateFlags(
    [
      cand(0, { betType: "MONEYLINE", category: "FAV_ML", pickedSide: "HOME", description: "Cubs ML" }),
      cand(1, { betType: "MONEYLINE", category: "DOG_ML", pickedSide: "HOME", description: "Cubs ML" }),
      cand(2, { betType: "MONEYLINE", category: "DOG_ML", pickedSide: "AWAY", description: "Brewers ML" }),
    ],
    DRIFT
  );
  check("preview: the flipped moneyline is flagged, the other team's is not", Object.keys(mlFlags).join(",") === "1", Object.keys(mlFlags).join(","));

  // ---- the review screen's gate ----
  check("nothing running, nothing failed: Import is allowed", !duplicateCheckBlocksImport(duplicateCheckStatus(0, false)));
  check("a running check blocks Import", duplicateCheckStatus(1, false) === "checking" && duplicateCheckBlocksImport("checking"));
  check("a failed check blocks Import", duplicateCheckStatus(0, true) === "failed" && duplicateCheckBlocksImport("failed"));
  check("still checking wins over an earlier failure", duplicateCheckStatus(2, true) === "checking");

  // The form's flow around the check, with the check itself failing.
  const runCheck = async (work: Promise<Record<number, { message: string }>>, timeoutMs: number) => {
    let pending = 1;
    let failed = false;
    let flagged = -1;
    await withTimeout(work, timeoutMs, "The duplicate check timed out.")
      .then(
        (f) => {
          flagged = Object.keys(f).length;
        },
        () => {
          failed = true;
        }
      )
      .finally(() => {
        pending--;
      });
    return { status: duplicateCheckStatus(pending, failed), flagged };
  };
  const ok = await runCheck(Promise.resolve({ 3: { message: "dup" } }), 1000);
  check("a check that returns leaves Import allowed, with its flags", ok.status === "idle" && ok.flagged === 1);
  const errored = await runCheck(Promise.reject(new Error("server action failed")), 1000);
  check("a check that errors blocks the import", errored.status === "failed" && duplicateCheckBlocksImport(errored.status));
  const timedOut = await runCheck(new Promise(() => {}), 30);
  check("a check that never returns times out and blocks the import", timedOut.status === "failed" && duplicateCheckBlocksImport(timedOut.status));
  // LEGACY: the form awaited the check under Promise.allSettled and read no result from a rejection.
  const legacy = await Promise.allSettled([Promise.reject(new Error("server action failed"))]);
  check("LEGACY reproduces: the old flow turned a failed check into 'no duplicates'", !legacy.some((c) => c.status === "fulfilled" && c.value > 0));

  // ---- fuzzy capper: the check runs under the resolved name ----
  const NEW = "__new__";
  const stale: Record<string, string> = {};
  const next = { ...stale, "Bullies PICK": "Bullies PICKS" };
  check("LEGACY reproduces: the pre-click choices send the pasted name", resolveCapperName(stale, "Bullies PICK", NEW) === "Bullies PICK");
  check('after "Yes, same as X" the check runs under X', resolveCapperName(next, "Bullies PICK", NEW) === "Bullies PICKS");
  check('"no, a new capper" keeps the pasted name', resolveCapperName({ "Bullies PICK": NEW }, "Bullies PICK", NEW) === "Bullies PICK");
  check("other cappers are untouched", resolveCapperName(next, "RHINO", NEW) === "RHINO");

  const form = readFileSync("src/components/dashboard/bulk-import-form.tsx", "utf8").replace(/\r\n/g, "\n");
  check(
    "form: both fuzzy answers re-check with the choices they just set",
    (form.match(/checkDuplicatesFor\(validEntries\.filter\(\(e\) => e\.p\.capperName === name\), nextChoices\)/g) ?? []).length === 2
  );
  check("form: no re-check reads the stale state", !/checkDuplicatesFor\(validEntries\.filter\(\(e\) => e\.p\.capperName === name\)\);/.test(form));
  check("form: the check is sent under the choices it was given", form.includes("capperName: resolveCapperName(fuzzyChoices, e.p.capperName, CONFIRMED_NEW)"));
  check("form: Import is disabled by the gate", /const canImport =[\s\S]{0,200}!duplicateCheckBlocksImport\(dupCheckStatus\);/.test(form) && form.includes("disabled={importing || !canImport}"));
  check("form: handleImport refuses while the gate is closed", /async function handleImport\(\) \{\n[^\n]*\n\s*if \(duplicateCheckBlocksImport\(dupCheckStatus\)\) return;/.test(form));
  check('form: shows "Checking for duplicates…"', form.includes('dupCheckStatus === "checking"') && form.includes("Checking for duplicates…"));
  check("form: a failed check shows the error and a retry", form.includes("{DUPLICATE_CHECK_FAILED_MESSAGE}") && form.includes("onClick={retryDuplicateCheck}"));
  check("form: each pick carries its own override", form.includes('overrideDuplicate: Boolean(duplicateFlags[idx]) && duplicateChoices[idx] === "import"'));

  // ---- every Pick insert goes through the server-side check ----
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name) && !/-test\.ts$/.test(name)) files.push(full.replace(/\\/g, "/"));
    }
  };
  walk("src");
  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (/\.pick\.(create|createMany|createManyAndReturn|upsert)\(/.test(text) && !file.endsWith("server/data/subscriptions.ts")) offenders.push(file + " writes picks");
    if (/\b(createPicksWithEntitlementCheck|insertPicksWithEntitlementCheck)\(/.test(text) && !file.endsWith("server/data/subscriptions.ts")) {
      offenders.push(file + " inserts without the duplicate check");
    }
    if (/\binsertPicksInTransaction\(/.test(text) && !/server\/data\/(subscriptions|pick-dedup)\.ts$/.test(file)) offenders.push(file + " bypasses insertPicksDeduped");
  }
  check("no runtime code inserts a Pick except through insertPicksDeduped", offenders.length === 0, offenders.join("; "));
  const action = readFileSync("src/server/actions/bulk-picks.ts", "utf8");
  check("bulkImportPicksAction inserts through insertPicksDeduped", /insertPicksDeduped\(user\.id, toInsert\)/.test(action));
  check("createPick inserts through insertPicksDeduped", /insertPicksDeduped\(userId, \[/.test(readFileSync("src/server/data/picks.ts", "utf8")));

  // ---- merge report ----
  const dup = {
    keptPickId: "p1",
    movedPickId: "p2",
    keptLabel: "Wyoming +10.5",
    movedLabel: "Wyoming +10",
    homeTeam: "Air Force Falcons",
    awayTeam: "Wyoming Cowboys",
    gameTime: new Date(T0),
  };
  check("merge report: nothing to say for no duplicates", mergeDuplicateHeadline(0) === "" && mergeDuplicateLines([]).length === 0);
  check("merge report: the headline says nothing was deleted", mergeDuplicateHeadline(2).includes("2 moved picks are") && mergeDuplicateHeadline(1).includes("Nothing was deleted"));
  check(
    "merge report: a line names the game, both bets and both pick ids",
    mergeDuplicateLines([dup])[0] === 'Wyoming Cowboys @ Air Force Falcons (2026-10-10): "Wyoming +10.5" / "Wyoming +10" - picks p1 and p2',
    mergeDuplicateLines([dup])[0]
  );
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    if (failures > 0) {
      console.error(`\n${failures} assertion(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll duplicate-check gate assertions passed.");
  });
