// T2 harness: item 4 of the T2 build task. Runs the SAME implementation
// ("old") on both sides of the diff, across both fixture users, and asserts
// two things per run - not just one:
//
//   1. The diff itself is empty (old vs old must never report a false
//      positive).
//   2. The 6 required scenarios were actually, meaningfully exercised by the
//      captured output - not just "the diff was empty", which would also be
//      true of a scenario that silently returned nothing on both sides. An
//      empty diff over untested ground proves nothing; this checks the
//      ground was actually covered.
//
// This has to pass before the harness is trusted to validate a real T3
// implementation (run-diff.mjs --impl-new=t3).
//
// Usage: node scripts/t2-harness/validate-old-vs-old.mjs
import { runDiffOnce } from "./run-diff.mjs";
import { formatDiffReport } from "./lib/deep-diff.mjs";

function findByName(entries, name) {
  return (entries ?? []).find((e) => e.name === name);
}

// Each assertion: [scenario label, check function(out) -> true/throw]
function scenarioChecks(out) {
  return [
    [
      "all leagues, no favorites (User A)",
      () => {
        if (out["favoritesSummary.ALL"] !== null) {
          throw new Error(`expected favoritesSummary.ALL to be null for a no-favorites user, got ${JSON.stringify(out["favoritesSummary.ALL"])}`);
        }
        if (!Array.isArray(out["leaderboard.allLeagues.ALL"]) || out["leaderboard.allLeagues.ALL"].length === 0) {
          throw new Error("expected a non-empty all-leagues leaderboard for User A");
        }
      },
    ],
    [
      "a league filter active (MLB vs all leagues differ)",
      () => {
        const all = out["leaderboard.allLeagues.ALL"];
        const mlbOnly = out["leaderboard.MLB.ALL"];
        const capD_all = findByName(all, "Fixture Cap D");
        const capD_mlb = findByName(mlbOnly, "Fixture Cap D");
        if (!capD_all || !capD_mlb) throw new Error("expected Fixture Cap D in both the all-leagues and MLB-filtered leaderboards");
        if (JSON.stringify(capD_all.stats) === JSON.stringify(capD_mlb.stats)) {
          throw new Error("expected Fixture Cap D's stats to differ between all-leagues and MLB-filtered (it has picks in both sports) - league filtering may not be taking effect");
        }
      },
    ],
    [
      "a zero-pick capper present (ALL window only)",
      () => {
        const all = out["leaderboard.allLeagues.ALL"];
        const zeroPick = findByName(all, "Fixture Cap C (zero-pick)");
        if (!zeroPick) throw new Error("expected 'Fixture Cap C (zero-pick)' to appear in the ALL window - it has zero picks, so this checks the show-every-capper invariant");
        if (zeroPick.stats.wins + zeroPick.stats.losses + zeroPick.stats.pushes !== 0) {
          throw new Error("expected the zero-pick capper's stats to show 0 decided picks");
        }
        const last7 = out["leaderboard.allLeagues.LAST_7"];
        if (findByName(last7, "Fixture Cap C (zero-pick)")) {
          throw new Error("expected the zero-pick capper to be EXCLUDED from a non-ALL window (excludesZeroPick behavior)");
        }
      },
    ],
    [
      "the category panel path",
      () => {
        const panel = out["categoryPanel.MLB"];
        if (!panel || !Array.isArray(panel.breakdown) || panel.breakdown.length === 0) {
          throw new Error("expected a non-empty category breakdown for MLB");
        }
        const anyLeaderboardEntries = Object.values(panel.leaderboards ?? {}).some((arr) => Array.isArray(arr) && arr.length > 0);
        if (!anyLeaderboardEntries) {
          throw new Error("expected at least one category to have a populated leaderboard (Fixture Cap B's 4 FAV_ML picks) - category panel may not be exercising real data");
        }
      },
    ],
    [
      "a mix of pending and graded picks",
      () => {
        const all = out["leaderboard.allLeagues.ALL"];
        const capA = findByName(all, "Fixture Cap A");
        if (!capA) throw new Error("expected Fixture Cap A in the ALL window");
        const decided = capA.stats.wins + capA.stats.losses + capA.stats.pushes;
        if (decided !== 6) {
          throw new Error(`expected Fixture Cap A to show exactly 6 decided picks (1 of its 7 seeded picks is PENDING and must be excluded), got ${decided}`);
        }
      },
    ],
  ];
}

function scenarioChecksFavorites(out) {
  return [
    [
      "all leagues, favorites present (User B)",
      () => {
        const summary = out["favoritesSummary.ALL"];
        if (!summary) throw new Error("expected a non-null favoritesSummary.ALL for User B (has a favorited capper)");
        if (!Array.isArray(summary.entries) || summary.entries.length === 0) {
          throw new Error("expected favoritesSummary.ALL.entries to contain at least the favorited capper");
        }
        if (!findByName(summary.entries, "Fixture Cap E (favorited)")) {
          throw new Error("expected 'Fixture Cap E (favorited)' in the favorites summary entries");
        }
      },
    ],
  ];
}

function runValidation(fixtureUser, checksFn, label) {
  console.log(`\n${"#".repeat(60)}\n# validating: ${label}\n${"#".repeat(60)}`);
  const { runId, diffs, oldOut } = runDiffOnce({
    source: "fixtures",
    implOld: "old",
    implNew: "old",
    userSelector: [`--fixture-user=${fixtureUser}`],
    label,
  });

  let failures = 0;

  if (diffs.length > 0) {
    console.log(`  ✗ old-vs-old reported ${diffs.length} difference(s) (should be zero):`);
    console.log(formatDiffReport(diffs));
    failures++;
  } else {
    console.log(`  ✓ old-vs-old: zero differences`);
  }

  for (const [scenario, check] of checksFn(oldOut)) {
    try {
      check();
      console.log(`  ✓ scenario exercised: ${scenario}`);
    } catch (e) {
      console.log(`  ✗ scenario NOT properly exercised: ${scenario}\n      ${e.message}`);
      failures++;
    }
  }

  return { runId, failures };
}

function main() {
  let totalFailures = 0;
  totalFailures += runValidation("A", scenarioChecks, "User A (no favorites / league-filter / zero-pick / category-panel / pending-graded-mix)").failures;
  totalFailures += runValidation("B", scenarioChecksFavorites, "User B (favorites present)").failures;

  console.log(`\n${"=".repeat(60)}`);
  if (totalFailures === 0) {
    console.log("[t2-harness] validate-old-vs-old: ALL CHECKS PASSED - harness is trustworthy for a real T3 diff.");
    process.exit(0);
  } else {
    console.log(`[t2-harness] validate-old-vs-old: ${totalFailures} CHECK(S) FAILED - do not use this harness to validate T3 until fixed.`);
    process.exit(1);
  }
}

main();
