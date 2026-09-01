// Presentation-only downsampling for the dashboard units chart (the M3
// "scale-readiness follow-up"). A power user with a 20k+ settled-pick history
// produces a cumulative-units series with one point per settled pick - far
// more than the ~900px-wide chart can render distinctly, and a large payload
// to sit in the M3 dashboard cache and ship on every load.
//
// This does NOT replace computeUnitsChartData / computeCumulativeUnitsSeries -
// those stay full-fidelity (computeMaxDrawdown and the per-capper page depend
// on that). It is applied ONLY inside computeDashboardSummary, on top of the
// full series.
//
// X-axis note: the chart's XAxis is a plain categorical `dataKey="date"` -
// Recharts places one slot per array element at equal spacing, so the axis is
// effectively pick-sequence, not a time scale. Bucketing is therefore
// index-based (contiguous ranges of array positions), not time-based.

export const UNITS_CHART_MAX_POINTS = 2000;

type CumulativePoint = { cumulativeUnits: number };

// Extrema-preserving index bucketing.
//
// - points[0] and points[n-1] are kept EXACTLY (so the downsampled series ends
//   on the same cumulative value as the full series).
// - The interior is split into ~(MAX-2)/2 contiguous index buckets.
// - From each bucket, the point with the lowest cumulativeUnits AND the point
//   with the highest are kept (deduped when they are the same index), emitted
//   in original index order - so a drawdown or spike whose extreme lands in a
//   bucket cannot vanish between retained samples, and the global min/max of
//   the whole series are always retained.
// - Every returned element is an exact original object; matched original
//   indices are strictly ascending. Nothing is synthesized or interpolated.
//
// Output size is <= MAX but often well below it: a monotonic bucket has
// min-index == max-index and contributes a single point. That is correct -
// the goal is preserving visual information, not artificial density.
//
// Deterministic (stable first-index tie-break, no clock, no RNG), so the
// result caches alongside the rest of computeDashboardSummary under the
// existing dashboard:${userId} key with no new dimension.
export function downsampleUnitsChart<T extends CumulativePoint>(points: T[]): T[] {
  const n = points.length;
  if (n <= UNITS_CHART_MAX_POINTS) return points;

  const bucketCount = Math.floor((UNITS_CHART_MAX_POINTS - 2) / 2); // 999
  const interiorStart = 1;
  const interiorEnd = n - 1; // exclusive
  const interiorLen = interiorEnd - interiorStart;
  const bucketSize = interiorLen / bucketCount;

  const result: T[] = [points[0]];

  for (let b = 0; b < bucketCount; b++) {
    const from = interiorStart + Math.floor(b * bucketSize);
    const to = interiorStart + Math.floor((b + 1) * bucketSize); // exclusive
    if (to <= from) continue;

    let minIdx = from;
    let maxIdx = from;
    for (let i = from + 1; i < to; i++) {
      const v = points[i].cumulativeUnits;
      if (v < points[minIdx].cumulativeUnits) minIdx = i;
      if (v > points[maxIdx].cumulativeUnits) maxIdx = i;
    }

    const lo = Math.min(minIdx, maxIdx);
    const hi = Math.max(minIdx, maxIdx);
    result.push(points[lo]);
    if (hi !== lo) result.push(points[hi]);
  }

  result.push(points[n - 1]);
  return result;
}
