// Telegram ingest with BOTH NCAAF and NCAAB allowed (the default since NCAAB got a game feed).
//   npx tsx src/lib/ingest-college-allowlist-acceptance-test.ts
//
// Pure: no DB, no network. Runs the same order the ingest runs (orchestrator hooks):
//   withCollegeCandidates -> narrowAmbiguousByLeague -> runAmbiguousHierarchy -> filterPicksByLeague
// with the schedule feeds replaced by fixed answers. A shared school must stay a question when both leagues
// are allowed (and nothing settles it); it must still narrow when the allowlist leaves one out.
import { NCAAB_LISTED_TEAMS } from "@/lib/college-teams";
import { runAmbiguousHierarchy, type ScheduleChecker } from "@/lib/ambiguous-hierarchy";
import { DEFAULT_INGEST_ALLOWED_LEAGUES, filterPicksByLeague, narrowAmbiguousByLeague, parseAllowedLeagues } from "@/lib/ingest-filters";
import { parseCatalog, withCollegeCandidates, type ParsedPick } from "@/lib/parse-catalog";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

// A date inside both seasons (NCAAF to 2027-02-01, NCAAB from 2026-11-01).
const NOW = new Date("2026-11-10T17:00:00Z");
const parse = (lines: string[]) => parseCatalog("Sharp\n" + lines.join("\n") + "\n", ["Sharp"], undefined, NCAAB_LISTED_TEAMS);
const schedule = (playing: (q: string) => boolean): ScheduleChecker => async (queries) =>
  Object.fromEntries(queries.map((q) => [q.nickname + "|" + q.sport, playing(q.nickname + "|" + q.sport)]));

type Outcome = { sport: string; question: string[] | null; skipped: string[] };
// One ingest pass over the picks, as runCatalogImportForUser does it.
async function ingest(allowedRaw: string | undefined, lines: string[], playing: (q: string) => boolean): Promise<Outcome[]> {
  const allowed = parseAllowedLeagues(allowedRaw);
  const log = console.log;
  console.log = () => {};
  try {
    const parsed = parse(lines).picks;
    const prep = narrowAmbiguousByLeague(allowed, withCollegeCandidates(parsed));
    const resolved = await runAmbiguousHierarchy(prep.keep, {}, {
      runScheduleCheck: schedule(playing),
      runWideScheduleCheck: schedule(playing),
      now: NOW,
    });
    const questions = resolved.picks.filter((p: ParsedPick) => p.ambiguous && p.ambiguousKey);
    const candidates = resolved.picks.filter((p: ParsedPick) => !(p.ambiguous && p.ambiguousKey));
    const f = filterPicksByLeague(allowed, candidates);
    return [
      ...f.keep.map((p) => ({ sport: p.sportName, question: null, skipped: [] as string[] })),
      ...questions.map((p) => ({ sport: "", question: (p.ambiguous ?? []).map((o) => o.sport).sort(), skipped: [] as string[] })),
      ...[...prep.skipped, ...f.skipped].map((s) => ({ sport: "", question: null, skipped: [s.stage] })),
    ];
  } finally {
    console.log = log;
  }
}

async function main() {
  check("default allowlist includes NCAAB", DEFAULT_INGEST_ALLOWED_LEAGUES.split(",").includes("NCAAB"), true);
  check("default allowlist keeps NCAAF", DEFAULT_INGEST_ALLOWED_LEAGUES.split(",").includes("NCAAF"), true);
  check("unset env -> default set", [...parseAllowedLeagues(undefined)].sort(), ["MLB", "NBA", "NCAAB", "NCAAF", "NFL", "NHL", "WNBA"]);

  const bothPlay = () => true;

  // 1. A basketball-only school imports as NCAAB (and was LEAGUE_NOT_ALLOWED before).
  {
    const r = await ingest(undefined, ["Gonzaga -5"], bothPlay);
    check("Gonzaga (basketball-only) imports as NCAAB", r, [{ sport: "NCAAB", question: null, skipped: [] }]);
    const old = await ingest("NBA,NFL,NCAAF,NHL,WNBA,MLB", ["Gonzaga -5"], bothPlay);
    check("Gonzaga under the OLD allowlist was LEAGUE_NOT_ALLOWED", old.map((o) => o.skipped), [["LEAGUE_NOT_ALLOWED"]]);
  }

  // 2. A shared school with only football on the schedule resolves to NCAAF (the hierarchy, not the allowlist).
  {
    const r = await ingest(undefined, ["Alabama ML"], (q) => q.endsWith("|NCAAF"));
    check("shared school, only NCAAF plays -> NCAAF", r, [{ sport: "NCAAF", question: null, skipped: [] }]);
    const b = await ingest(undefined, ["Alabama ML"], (q) => q.endsWith("|NCAAB"));
    check("shared school, only NCAAB plays -> NCAAB", b, [{ sport: "NCAAB", question: null, skipped: [] }]);
  }

  // 3. A shared school nothing can settle stays a question (NCAAF vs NCAAB), never guessed and never skipped.
  {
    const r = await ingest(undefined, ["Alabama ML"], bothPlay);
    check("shared school, both play, no signal -> NCAAF/NCAAB question", r, [{ sport: "", question: ["NCAAB", "NCAAF"], skipped: [] }]);
    // Pinned for the record: with NCAAB left off the allowlist the pick is narrowed to NCAAF, but the hierarchy's
    // step 0 (withCollegeCandidates) promotes a shared school again, so it is a question here too. This is how main
    // behaves today and this change does not touch it.
    const off = await ingest("NBA,NFL,NCAAF,NHL,WNBA,MLB", ["Alabama ML"], bothPlay);
    check("allowlist without NCAAB: same pick is also a question (unchanged from main)", off, [{ sport: "", question: ["NCAAB", "NCAAF"], skipped: [] }]);
  }

  // 4. Everything else is unchanged: a config that still leaves NCAAB out behaves as before, and non-college picks
  //    are identical with or without NCAAB allowed.
  {
    const noBasketball = "NBA,NFL,NCAAF,NHL,WNBA,MLB";
    const g = await ingest(noBasketball, ["Gonzaga -5"], bothPlay);
    check("NCAAB off by config -> basketball-only school still LEAGUE_NOT_ALLOWED", g.map((o) => o.skipped), [["LEAGUE_NOT_ALLOWED"]]);
    const f = await ingest(noBasketball, ["Alabama ML"], (q) => q.endsWith("|NCAAF"));
    check("NCAAB off by config -> football-only-on-schedule shared school is NCAAF", f, [{ sport: "NCAAF", question: null, skipped: [] }]);
    const lines = ["Chiefs ML", "Lakers ML"];
    const a = await ingest(undefined, lines, bothPlay);
    const b = await ingest(noBasketball, lines, bothPlay);
    check("NFL / NBA picks identical with or without NCAAB allowed", a, b);
    check("NFL / NBA picks import", a.map((o) => o.sport).sort(), ["NBA", "NFL"]);
  }

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll passed");
}
main();
