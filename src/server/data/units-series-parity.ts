// Verification helper (not used by any page): the BIT-EXACT parity check that decides
// whether the dashboard's SQL running-sum + downsample (page-aggregate-fragments.ts
// unitsSeriesSelect) may ship - design doc §8 / Q10. Compares it, for one user [or one
// capper], against the JS path it replaces: computeCumulativeUnitsSeries +
// downsampleUnitsChart (via computeUnitsChartData for the labelled points).
//
// Gate (doc §5): every DISPLAYED value is `===`-equal (-0 == +0): which points survive
// (index), their time, and round2(run), plus the final labelled chart points. Reported
// but NON-gating: any difference in the unrounded running sum, printed so an ordering or
// operation mismatch that rounding happens to hide still gets looked at.
//
// Used by units-series-downsample-acceptance-test.ts (synthetic 2,000/2,001/2,002/5k/20k)
// and scripts/t2-harness/units-series-parity.ts (the anonymized production snapshot).
import { prisma } from "@/lib/prisma";
import { UNITS_CHART_MAX_POINTS, downsampleUnitsChart } from "@/server/data/units-chart-downsample";
import { computeCumulativeUnitsSeries, computeUnitsChartData, round2, unitsWonOnBet } from "@/server/data/stats";
import {
  UNITS_SERIES_ORDER_BY,
  buildPageBundleQuery,
  chartPointsFromSeriesRows,
  queryPageBundle,
  queryUnitsSeries,
  unitsSeriesRowsFromBundle,
  unitsSeriesSelect,
  type UnitsSeriesRow,
} from "@/server/data/page-aggregate-fragments";

export type SeriesParityResult = {
  n: number; // settled picks in scope (length of the full JS series)
  jsPoints: number; // length of the downsampled JS series
  sqlRows: number; // rows the database returned
  downsampledInSql: boolean;
  displayDiffs: string[]; // gating: empty == pass
  rawRunDiffs: number; // non-gating: unrounded running sums that differ bit-for-bit
};

const same = (a: number, b: number) => a === b; // -0 === +0 is true, which is what §5 asks for

function compareRows(label: string, rows: UnitsSeriesRow[], expected: { i: number; t: number; cum: number; run: number }[], out: SeriesParityResult) {
  if (rows.length !== expected.length) {
    out.displayDiffs.push(`${label}: ${rows.length} rows vs ${expected.length} JS points`);
    return;
  }
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    const e = expected[k];
    if (r.idx !== e.i) out.displayDiffs.push(`${label}[${k}]: idx ${r.idx} vs JS ${e.i}`);
    else if (Number(r.t) !== e.t) out.displayDiffs.push(`${label}[${k}]: t ${r.t} vs JS ${e.t}`);
    else if (!same(round2(r.run), e.cum)) out.displayDiffs.push(`${label}[${k}]: round2(run) ${round2(r.run)} vs JS ${e.cum}`);
    if (!same(r.run, e.run)) out.rawRunDiffs++;
    if (out.displayDiffs.length >= 20) return;
  }
}

export async function compareUnitsSeriesParity(scope: { userId: string; capperId?: string }): Promise<SeriesParityResult> {
  const picks = await prisma.pick.findMany({
    where: { userId: scope.userId, ...(scope.capperId ? { capperId: scope.capperId } : {}) },
    select: { id: true, createdAt: true, gameTime: true, gradedAt: true, status: true, units: true, odds: true },
  });

  // JS reference: the series, its raw running sum recomputed in the same order with the same
  // operations (computeCumulativeUnitsSeries only keeps the rounded value), then downsampled.
  const series = computeCumulativeUnitsSeries(picks);
  let running = 0;
  const full = series.map((pt, i) => {
    if (pt.pick.status === "WIN") running += unitsWonOnBet(pt.pick.units, pt.pick.odds);
    else if (pt.pick.status === "LOSS") running -= pt.pick.units;
    return { ...pt, i, run: running };
  });
  const ds = downsampleUnitsChart(full);
  const expected = ds.map((p) => ({ i: p.i, t: p.pick.gameTime.getTime(), cum: p.cumulativeUnits, run: p.run }));
  const jsChart = downsampleUnitsChart(computeUnitsChartData(picks));

  const out: SeriesParityResult = {
    n: full.length,
    jsPoints: ds.length,
    sqlRows: 0,
    downsampledInSql: false,
    displayDiffs: [],
    rawRunDiffs: 0,
  };

  // Standalone statement (float8 straight from the driver) ...
  const direct = await queryUnitsSeries(scope);
  out.sqlRows = direct.length;
  out.downsampledInSql = full.length > UNITS_CHART_MAX_POINTS && direct.length < full.length;
  compareRows("direct", direct, expected, out);
  // ... and the same fragment through the jsonb bundle a page would use (float8 -> jsonb -> JSON.parse).
  const bundle = await queryPageBundle(
    buildPageBundleQuery({ parts: [{ name: "series", select: unitsSeriesSelect(scope), orderBy: UNITS_SERIES_ORDER_BY }] })
  );
  const viaJson = unitsSeriesRowsFromBundle(bundle.series ?? []);
  compareRows("bundle", viaJson, expected, out);

  if (full.length > UNITS_CHART_MAX_POINTS && direct.length > UNITS_CHART_MAX_POINTS) {
    out.displayDiffs.push(`SQL returned ${direct.length} rows for n=${full.length}: it did not downsample`);
  }

  // The labelled points the dashboard would render.
  const sqlChart = chartPointsFromSeriesRows(viaJson);
  if (sqlChart.length !== jsChart.length) out.displayDiffs.push(`chart: ${sqlChart.length} points vs JS ${jsChart.length}`);
  else {
    for (let k = 0; k < sqlChart.length; k++) {
      if (sqlChart[k].date !== jsChart[k].date || !same(sqlChart[k].cumulativeUnits, jsChart[k].cumulativeUnits)) {
        out.displayDiffs.push(`chart[${k}]: ${JSON.stringify(sqlChart[k])} vs JS ${JSON.stringify(jsChart[k])}`);
        break;
      }
    }
  }
  return out;
}

