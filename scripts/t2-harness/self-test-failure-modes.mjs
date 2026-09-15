// T2 harness: item 3a/3b of the T2 build task. Proves the diff mechanism
// actually CATCHES the two concrete failure modes the T3 field-equivalence
// audit found on paper, rather than trusting that the audit's static
// reasoning transfers to a running diff. Does this by running "old" against
// two deliberately-broken variants (registered in capture-output.ts's
// IMPLEMENTATIONS map, self-test-only, never touching src/) and asserting a
// NON-empty, on-topic diff is produced - the inverse of validate-old-vs-old.mjs.
//
// Usage: node scripts/t2-harness/self-test-failure-modes.mjs
import { runDiffOnce } from "./run-diff.mjs";
import { formatDiffReport } from "./lib/deep-diff.mjs";

function expectDiffMatching(label, implNew, pathPattern, fixtureUser = "A") {
  console.log(`\n${"#".repeat(60)}\n# self-test: ${label}\n${"#".repeat(60)}`);
  const { runId, diffs } = runDiffOnce({
    source: "fixtures",
    implOld: "old",
    implNew,
    userSelector: [`--fixture-user=${fixtureUser}`],
    label,
  });

  if (diffs.length === 0) {
    console.log(`  ✗ FAIL: expected the diff to catch this regression, but old vs ${implNew} reported ZERO differences.`);
    console.log(`         The diff mechanism is not sensitive to this failure mode - do not trust it yet.`);
    return false;
  }

  const onTopic = diffs.filter((d) => pathPattern.test(d.path));
  console.log(`  found ${diffs.length} total difference(s), ${onTopic.length} matching ${pathPattern}:`);
  console.log(formatDiffReport(diffs.slice(0, 10)));
  if (diffs.length > 10) console.log(`  ...and ${diffs.length - 10} more`);

  if (onTopic.length === 0) {
    console.log(`  ✗ FAIL: differences were found, but none matched the expected path pattern ${pathPattern} - the diff may be catching something else, not this failure mode.`);
    return false;
  }

  console.log(`  ✓ PASS: the diff mechanism correctly caught this regression (run ${runId}).`);
  return true;
}

function main() {
  const results = [
    expectDiffMatching(
      "3a - silent field loss (capper.name gap in getSportCategoryPanelData)",
      "broken-capper-name",
      /^\$\.categoryPanel\..*\.name$/
    ),
    expectDiffMatching(
      "3b - zero-pick-capper disappearance (getCapperLeaderboardTable ALL window)",
      "broken-zero-pick",
      /^\$\.leaderboard\.allLeagues\.ALL(\.length|\[\d+\])/
    ),
  ];

  console.log(`\n${"=".repeat(60)}`);
  if (results.every(Boolean)) {
    console.log("[t2-harness] self-test-failure-modes: ALL PASSED - the diff mechanism is proven sensitive to both known failure modes.");
    process.exit(0);
  } else {
    console.log("[t2-harness] self-test-failure-modes: AT LEAST ONE FAILED - fix the diff mechanism before relying on it for a real T3 comparison.");
    process.exit(1);
  }
}

main();
