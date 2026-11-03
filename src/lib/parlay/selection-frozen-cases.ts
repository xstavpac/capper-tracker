// The setting shapes the selection-layer frozen diff runs (selection-frozen-diff-acceptance-test.ts) on the
// scoring switch's slate (scoring-switch-fixture.ts). selection-before-frozen.json is the engine at a2a012f
// (PR 4, before selection.ts) on exactly these cases. Pure - no DB.
import type { GeneratorSettings } from "@/lib/parlay/generator";

const base: GeneratorSettings = { legCount: 6, maxLegsPerGame: 1, include: "ALL", mix: null, fillFrom: "BEST_AVAILABLE" };

export const SELECTION_CASES: { label: string; settings: GeneratorSettings; slip: string[] }[] = [
  { label: "6 legs, best available, default gate", settings: base, slip: [] },
  { label: "8 legs, 2 per game, default gate", settings: { ...base, legCount: 8, maxLegsPerGame: 2 }, slip: [] },
  { label: "6 legs, 60% gate", settings: { ...base, minWinPct: 60 }, slip: [] },
  { label: "6 legs, no gate", settings: { ...base, minWinPct: 0 }, slip: [] },
  { label: "12 legs, 5 per game, no gate", settings: { ...base, legCount: 12, maxLegsPerGame: 5, minWinPct: 0 }, slip: [] },
  { label: "slip competing on one game, 4 legs", settings: { ...base, legCount: 4 }, slip: ["g2-heavy-fav", "g2-mid-under"] },
  { label: "slip on two games, 6 legs, 2 per game", settings: { ...base, legCount: 6, maxLegsPerGame: 2 }, slip: ["g0-elite-spread", "g5-home"] },
  { label: "Totals + Props only, 6 legs, 3 per game", settings: { ...base, include: ["TOTALS", "PROPS"], maxLegsPerGame: 3 }, slip: [] },
  { label: "Pick Mix 50/50 Spread / Totals, 6 legs, 2 per game", settings: { ...base, include: ["SPREAD", "TOTALS"], mix: { SPREAD: 50, TOTALS: 50 }, maxLegsPerGame: 2 }, slip: [] },
  { label: "Your picks only, 2 of 5", settings: { ...base, legCount: 2, fillFrom: "YOUR_PICKS_ONLY" }, slip: ["g1-55-45", "g2-heavy-fav", "g3-thin", "g0-small-spread", "g5-away"] },
  {
    label: "Your picks only, 4 of 8, 2 per game",
    settings: { ...base, legCount: 4, maxLegsPerGame: 2, fillFrom: "YOUR_PICKS_ONLY" },
    slip: ["g0-elite-spread", "g0-over", "g1-longshot", "g2-heavy-fav", "g2-mid-under", "g3-no-price", "g5-home", "g5-away"],
  },
];
