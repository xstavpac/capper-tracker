// Proof for select-checkbox-state.ts: Live's slip-mode checkboxes - a pick's
// (straight into the slip, started-game gate) and a game's "Target game".
// Pure: no DB, no network.
// Run with:
//   npx tsx src/lib/parlay/select-checkbox-state-acceptance-test.ts
import { selectCheckboxState, targetCheckboxState } from "@/lib/parlay/select-checkbox-state";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : " - expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)));
}

const NOW = new Date("2026-10-14T23:00:00Z");
const LATER = "2026-10-15T00:00:00Z";
const EARLIER = "2026-10-14T19:05:00Z";
const ENABLED = { disabled: false, title: "Add to Parlay slip" };
const STARTED = { disabled: true, title: "Game started" };
const IN_SLIP = { disabled: false, title: "In your Parlay slip - uncheck to remove" };

check("pick, before start: enabled", selectCheckboxState("2026-10-14T23:00:01Z", false, NOW), ENABLED);
check("pick, at start: disabled", selectCheckboxState(NOW.toISOString(), false, NOW), STARTED);
check("pick, after start: disabled", selectCheckboxState(EARLIER, false, NOW), STARTED);
check("pick, missing start time: disabled", selectCheckboxState("", false, NOW), STARTED);
check("pick, unparseable start time: disabled", selectCheckboxState("TBD", false, NOW), STARTED);
check("pick in the slip, before start: can be unchecked", selectCheckboxState(LATER, true, NOW), IN_SLIP);
check("pick in the slip, after start: can still be unchecked", selectCheckboxState(EARLIER, true, NOW), IN_SLIP);

check("game, before start: can be targeted", targetCheckboxState(LATER, false, false, NOW), { disabled: false, title: "Build from this game", label: "Target game" });
check("game, started: can't be targeted", targetCheckboxState(EARLIER, false, false, NOW), { disabled: true, title: "Game started", label: "Target game" });
check("game targeted: can be untargeted, even after start", targetCheckboxState(EARLIER, true, false, NOW), { disabled: false, title: "Stop targeting this game", label: "Target game" });
check("game with one of your picks: targeted via picks, locked", targetCheckboxState(LATER, false, true, NOW), {
  disabled: true,
  title: "Remove your picks on this game to stop targeting it",
  label: "Targeted via your picks",
});

if (failures) {
  console.log(failures + " failure(s)");
  process.exit(1);
}
console.log("All select-checkbox-state checks passed");
