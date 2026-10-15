// Proof for select-checkbox-state.ts (the Add to Parlay checkbox's
// started-game gate). Pure: no DB, no network.
// Run with:
//   npx tsx src/lib/parlay/select-checkbox-state-acceptance-test.ts
import { selectCheckboxState } from "@/lib/parlay/select-checkbox-state";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : " - expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)));
}

const NOW = new Date("2026-10-14T23:00:00Z");
const ENABLED = { disabled: false, title: "Add to Parlay slip" };
const STARTED = { disabled: true, title: "Game started" };

check("before start: enabled", selectCheckboxState("2026-10-14T23:00:01Z", false, NOW), ENABLED);
check("at start: disabled", selectCheckboxState(NOW.toISOString(), false, NOW), STARTED);
check("after start: disabled", selectCheckboxState("2026-10-14T19:05:00Z", false, NOW), STARTED);
check("missing start time: disabled", selectCheckboxState("", false, NOW), STARTED);
check("unparseable start time: disabled", selectCheckboxState("TBD", false, NOW), STARTED);
check("already on slip, before start: unchanged", selectCheckboxState("2026-10-15T00:00:00Z", true, NOW), {
  disabled: true,
  title: "Already in your Parlay slip",
});
check("already on slip, after start: unchanged (slip prune handles it)", selectCheckboxState("2026-10-14T19:05:00Z", true, NOW), {
  disabled: true,
  title: "Already in your Parlay slip",
});

if (failures) {
  console.log(failures + " failure(s)");
  process.exit(1);
}
console.log("All select-checkbox-state checks passed");
