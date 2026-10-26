// Proof for select-checkbox-state.ts: Live's slip-mode checkboxes - a pick's
// (straight into the slip, game-over gate; a live game is allowed) and a game's "Target game".
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
const OVER = { disabled: true, title: "Game over" };
const LIVE = { disabled: false, title: "Add to Parlay slip (game is live - odds may have moved)" };
const g = (gameTime: string, gameStatus?: "preview" | "live" | "final" | "postponed" | "cancelled") => ({ gameTime, gameStatus });
const IN_SLIP = { disabled: false, title: "In your Parlay slip - uncheck to remove" };

check("pick, before start: enabled", selectCheckboxState(g("2026-10-14T23:00:01Z"), false, NOW), ENABLED);
check("pick, at start (no feed status): live, enabled with the live title", selectCheckboxState(g(NOW.toISOString()), false, NOW), LIVE);
check("pick, after start, feed says live: enabled with the live title", selectCheckboxState(g(EARLIER, "live"), false, NOW), LIVE);
check("pick, after start, feed says preview (delayed start): enabled with the live title", selectCheckboxState(g(EARLIER, "preview"), false, NOW), LIVE);
check("pick, final: disabled", selectCheckboxState(g(EARLIER, "final"), false, NOW), OVER);
check("pick, postponed: disabled", selectCheckboxState(g(EARLIER, "postponed"), false, NOW), OVER);
check("pick, cancelled: disabled", selectCheckboxState(g(EARLIER, "cancelled"), false, NOW), OVER);
check("pick, no feed status and 6h+ past start: disabled", selectCheckboxState(g("2026-10-14T16:00:00Z"), false, NOW), OVER);
check("pick, missing start time: disabled", selectCheckboxState(g(""), false, NOW), OVER);
check("pick, unparseable start time: disabled", selectCheckboxState(g("TBD"), false, NOW), OVER);
check("pick in the slip, before start: can be unchecked", selectCheckboxState(g(LATER), true, NOW), IN_SLIP);
check("pick in the slip, after start: can still be unchecked", selectCheckboxState(g(EARLIER, "final"), true, NOW), IN_SLIP);

check("game, before start: can be targeted", targetCheckboxState(g(LATER), false, false, NOW), { disabled: false, title: "Build from this game", label: "Target game" });
check("game, live: can be targeted", targetCheckboxState(g(EARLIER, "live"), false, false, NOW), { disabled: false, title: "Build from this live game - odds may have moved", label: "Target game" });
check("game, final: can't be targeted", targetCheckboxState(g(EARLIER, "final"), false, false, NOW), { disabled: true, title: "Game over", label: "Target game" });
check("game targeted: can be untargeted, even after start", targetCheckboxState(g(EARLIER, "final"), true, false, NOW), { disabled: false, title: "Stop targeting this game", label: "Target game" });
check("game with one of your picks: targeted via picks, locked", targetCheckboxState(g(LATER), false, true, NOW), {
  disabled: true,
  title: "Remove your picks on this game to stop targeting it",
  label: "Targeted via your picks",
});

if (failures) {
  console.log(failures + " failure(s)");
  process.exit(1);
}
console.log("All select-checkbox-state checks passed");
