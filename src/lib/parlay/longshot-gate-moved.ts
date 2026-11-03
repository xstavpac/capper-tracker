// The frozen cases the long-shot gate (scoring.ts ls1) moved at their OWN gate setting: the older frozen diffs
// (contrarian-frozen-diff, nba-samegame-frozen-diff) compare against captures from before ls1, so these cases
// are expected to differ there. longshot-gate-frozen-diff-acceptance-test.ts checks this list against what it
// computes, so it can't drift. In every one of them the only pick whose gate verdict moved is g2-heavy-fav
// (Eagles ML -1000, 18-4: 81.8% raw under the 90.9% break-even), and only its Hedge moved.
export const LONGSHOT_MOVED_AT_OWN_GATE: readonly string[] = [
  "SWITCH · 6 legs, best available, default gate",
  "SWITCH · 8 legs, 2 per game, default gate",
  "SWITCH · slip on two games, 6 legs, 2 per game",
];
