// A pick's break-even in SQL when its stored price is real, else NULL: priceOf (lib/parlay/scoring.ts) as one
// CASE, so the record bundle, the platform rollup and the backtest all read prices the same way. The acceptance
// test runs this against priceOf over every rule. `p` is the alias of the picks table. Numeric, not float, so a
// sum rounds cleanly.
export function realBreakEvenSql(p: string): string {
  const breakEven = `CASE WHEN ${p}.odds > 0 THEN 100.0 / (${p}.odds + 100) ELSE (-${p}.odds)::numeric / (-${p}.odds + 100) END`;
  return `CASE
          WHEN ${p}."oddsSource"::text = 'DEFAULTED' OR abs(${p}.odds) < 100 THEN NULL
          WHEN ${p}."oddsSource" IS NOT NULL OR ${p}.odds <> -110 OR ${p}."betType"::text IN ('SPREAD', 'TOTAL') THEN ${breakEven}
          ELSE NULL
        END`;
}
