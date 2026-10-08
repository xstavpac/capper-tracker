// Wilson score interval lower bound (docs/parlay-white-paper.md, Section 7 Step 1).
//   p = wins/decided, n = decided (pushes excluded, same as computeStats).
//   LB = (p + z²/2n - z*sqrt(p(1-p)/n + z²/4n²)) / (1 + z²/n)
// In its own import-free module so client code (the /live category panel) can
// rank with the exact function the Parlay Generator uses without pulling
// qualification-ranking.ts's server-side imports into the browser bundle.
export function wilsonLowerBound(wins: number, losses: number, z = 1.96): number {
  const decided = wins + losses;
  if (decided <= 0) return 0;
  const p = wins / decided;
  const n = decided;
  const z2 = z * z;
  const numerator = p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denominator = 1 + z2 / n;
  return numerator / denominator;
}
