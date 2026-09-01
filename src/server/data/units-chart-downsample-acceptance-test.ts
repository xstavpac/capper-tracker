// Proof for downsampleUnitsChart (units-chart-downsample.ts) - the dashboard
// units-chart downsampling. Run with:
//   npx tsx src/server/data/units-chart-downsample-acceptance-test.ts
//
// Pure: no DB, no prisma import. The function operates on a plain
// { cumulativeUnits }[] array.
//
// What is deliberately NOT tested: "every downsampled point is within X of
// itself" - vacuous, since retained points are exact values from the true
// curve. Instead we (a) reconstruct the curve by linear interpolation of the
// downsampled series and measure its error against the true curve, and (b)
// assert planted extrema survive exactly, including across a bucket boundary.
//
// About the reconstruction tolerance: extrema preservation is an exact
// property of the algorithm. Low reconstruction error is NOT - it is
// fixture-specific. A bucket that contains a sharp isolated feature keeps that
// feature's exact extreme, but the other points in that same bucket are
// dropped and linear interpolation between the retained extreme and the far
// end of the bucket can be meaningfully off. This fixture deliberately plants
// such features; the whole-curve tolerance is fitted to them. Away from the
// planted features the reconstruction is tight (asserted separately, < 1u).
import { downsampleUnitsChart, UNITS_CHART_MAX_POINTS } from "@/server/data/units-chart-downsample";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}
function checkLt(label: string, actual: number, bound: number) {
  const pass = actual < bound;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> ${actual.toFixed(4)} < ${bound}`);
  if (!pass) failures++;
}

type Point = { cumulativeUnits: number };

const N = 12_000;
// Same bucketing arithmetic the function uses - so the fixture can place a
// feature exactly across a bucket boundary.
const BUCKET_COUNT = Math.floor((UNITS_CHART_MAX_POINTS - 2) / 2); // 999
const BUCKET_SIZE = (N - 2) / BUCKET_COUNT;
const bucketStart = (k: number) => 1 + Math.floor(k * BUCKET_SIZE); // first interior index of bucket k

// A smooth, gently-oscillating rising trend (period ~5,700 pts, >> bucket
// width ~12) with tiny sub-unit noise.
function trend(i: number): number {
  return 8 + 0.012 * i + 6 * Math.sin(i / 900) + 0.12 * Math.sin(i / 1.7);
}

const y = new Array<number>(N);
for (let i = 0; i < N; i++) y[i] = trend(i);

// --- Feature A: cross-bucket drawdown. Peak in bucket 401, trough as the
//     FIRST interior index of bucket 402 - so extrema preservation must hold
//     ACROSS the boundary, not just within one bucket. ~70u peak-to-trough,
//     larger than any trend movement, so this is the series' max drawdown.
const boundary = bucketStart(402);
const aPeak = boundary - 2; // last-but-one index of bucket 401
const aTrough = boundary; // first index of bucket 402
y[aPeak] += 35;
y[boundary - 1] += 12;
y[aTrough] -= 35;
y[boundary + 1] -= 12;

// --- Feature B: narrow, high-amplitude spike fully inside bucket 150. Peak
//     retained exactly; the two shoulders are dropped and reconstruct
//     imperfectly - part of what the whole-curve tolerance accounts for.
const bSpike = bucketStart(150) + 5;
y[bSpike - 1] += 4;
y[bSpike] += 14; // the peak
y[bSpike + 1] += 4;

// --- Feature C: global-min drawdown, planted early where the trend is low so
//     it is genuinely the series minimum.
const cMin = bucketStart(30) + 5;
y[cMin - 1] -= 12;
y[cMin] -= 28;
y[cMin + 1] -= 12;

// --- Feature D: a long FLAT plateau (a capper who went inactive - cumulative
//     units unchanged for a long run). Every bucket fully inside it has
//     min == max and contributes ONE point, pulling the output well below
//     2,000. That is correct, desirable behavior - only `<= MAX` is asserted.
const flatFrom = bucketStart(500);
const flatTo = bucketStart(800);
const flatValue = y[flatFrom];
for (let i = flatFrom; i < flatTo; i++) y[i] = flatValue;
// resume the trend from the plateau level after flatTo
const resumeOffset = flatValue - trend(flatTo);
for (let i = flatTo; i < N; i++) y[i] = trend(i) + resumeOffset;

const full: Point[] = y.map((v) => ({ cumulativeUnits: Math.round(v * 100) / 100 }));

function maxDrawdown(series: Point[]): number {
  let peak = -Infinity;
  let dd = 0;
  for (const p of series) {
    if (p.cumulativeUnits > peak) peak = p.cumulativeUnits;
    dd = Math.max(dd, peak - p.cumulativeUnits);
  }
  return Math.round(dd * 100) / 100;
}

function main() {
  const down = downsampleUnitsChart(full);

  // ---- structural ----
  checkLt("output length <= UNITS_CHART_MAX_POINTS", down.length, UNITS_CHART_MAX_POINTS + 1);
  console.log(`   (informational: ${down.length} points from ${N}; the flat plateau collapses ~300 buckets to 1 point each)`);

  check("first point retained exactly", down[0] === full[0], true);
  check("last point retained exactly", down[down.length - 1] === full[N - 1], true);
  check(
    "downsampled[last].cumulative === full[last].cumulative (exact)",
    down[down.length - 1].cumulativeUnits === full[N - 1].cumulativeUnits,
    true
  );

  // Every downsampled point is an exact original object; matched original
  // indices strictly increasing.
  let scan = -1;
  let allOriginalInOrder = true;
  for (const p of down) {
    const idx = full.indexOf(p, scan + 1);
    if (idx === -1 || idx <= scan) {
      allOriginalInOrder = false;
      break;
    }
    scan = idx;
  }
  check("every downsampled point is an original point, strictly ascending index", allOriginalInOrder, true);

  // ---- extrema preservation (the exact correctness guarantee) ----
  const fullMax = Math.max(...full.map((p) => p.cumulativeUnits));
  const fullMin = Math.min(...full.map((p) => p.cumulativeUnits));
  check("global max retained exactly", Math.max(...down.map((p) => p.cumulativeUnits)) === fullMax, true);
  check("global min retained exactly", Math.min(...down.map((p) => p.cumulativeUnits)) === fullMin, true);
  check(
    "max drawdown preserved exactly (Feature A: peak + trough retained across the bucket boundary)",
    maxDrawdown(down) === maxDrawdown(full),
    true
  );
  check("A: cross-bucket peak survives as an exact point", down.some((p) => p === full[aPeak]), true);
  check("A: cross-bucket trough survives as an exact point", down.some((p) => p === full[aTrough]), true);
  check(
    "A: peak sits in bucket 401, trough is the first index of bucket 402 (=> different buckets, boundary crossed)",
    aPeak >= bucketStart(401) && aPeak < bucketStart(402) && aTrough === bucketStart(402),
    true
  );
  check("B: narrow spike peak survives as an exact point", down.some((p) => p === full[bSpike]), true);
  check("C: global-min drawdown point survives as an exact point", down.some((p) => p === full[cMin]), true);

  // ---- reconstruction error ----
  const keptIdx: number[] = [];
  {
    let s = -1;
    for (const p of down) {
      const idx = full.indexOf(p, s + 1);
      keptIdx.push(idx);
      s = idx;
    }
  }
  function reconstructAt(i: number): number {
    let lo = 0;
    let hi = keptIdx.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (keptIdx[mid] <= i) lo = mid;
      else hi = mid;
    }
    const a = keptIdx[lo];
    const b = keptIdx[hi];
    if (i <= a) return full[a].cumulativeUnits;
    if (i >= b) return full[b].cumulativeUnits;
    return full[a].cumulativeUnits + ((i - a) / (b - a)) * (full[b].cumulativeUnits - full[a].cumulativeUnits);
  }

  // ±10 indices around each planted sharp feature - the region where the
  // "diagonal across a bucket that also holds a sharp feature" artifact lives.
  const featureWindow = new Set<number>();
  for (const c of [aPeak, aTrough, bSpike, cMin]) for (let d = -10; d <= 10; d++) featureWindow.add(c + d);

  let maxErrAll = 0;
  let maxErrAway = 0;
  for (let i = 0; i < N; i++) {
    const err = Math.abs(reconstructAt(i) - full[i].cumulativeUnits);
    maxErrAll = Math.max(maxErrAll, err);
    if (!featureWindow.has(i)) maxErrAway = Math.max(maxErrAway, err);
  }
  const span = fullMax - fullMin;
  console.log(
    `   (informational: maxErrAll=${maxErrAll.toFixed(3)}, maxErrAway=${maxErrAway.toFixed(3)}, span=${span.toFixed(1)})`
  );

  // Whole-curve tolerance: FITTED TO THIS FIXTURE, dominated by the buckets
  // that hold Feature A / B / C. Not an algorithm guarantee. 40u ~= the
  // planted 70u cross-bucket swing crossed diagonally.
  checkLt("reconstruction max abs error over ALL points (fixture-fitted)", maxErrAll, 40);
  // Away from the planted sharp features - the smooth trend, the broad
  // oscillation, and the flat plateau all reconstruct to well under a unit.
  checkLt("reconstruction max abs error away from the planted features (< 1u)", maxErrAway, 1.0);

  // ---- threshold: at or below the limit, return unchanged ----
  const atLimit: Point[] = Array.from({ length: UNITS_CHART_MAX_POINTS }, (_, i) => ({ cumulativeUnits: i }));
  check("series exactly at the limit is returned unchanged (same reference)", downsampleUnitsChart(atLimit) === atLimit, true);
  const small: Point[] = Array.from({ length: 500 }, (_, i) => ({ cumulativeUnits: Math.sin(i) }));
  check("small series is returned unchanged (same reference)", downsampleUnitsChart(small) === small, true);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
