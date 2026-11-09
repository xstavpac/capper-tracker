import { formatAvg, formatNumber } from "@/lib/db-monitor";
import { TREND_DAYS, type QueryTrend } from "@/lib/query-stat-snapshots";

// The DB Monitor's daily trend for the tracked queries (query_stat_daily): per
// query, a rows-per-day sparkline, the totals and peak day, and the day-by-day
// table behind a <details>. Server-rendered; nothing to hydrate.

function Sparkline({ values }: { values: number[] }) {
  const w = 120;
  const h = 28;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Rows per day" className="text-foreground">
      {values.length > 1 ? <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.5} /> : <circle cx={2} cy={h / 2} r={2} fill="currentColor" />}
    </svg>
  );
}

export function QueryTrendPanel({ trends, unavailable }: { trends: QueryTrend[]; unavailable: boolean }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Daily trend, tracked queries</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          One row per query per UTC day, the difference between two daily pg_stat_statements snapshots (last {TREND_DAYS} days). Survives stats resets.
        </p>
      </div>
      {unavailable ? (
        <p className="text-sm text-muted-foreground">The snapshot table can&apos;t be read on this database (migration not applied?).</p>
      ) : trends.every((t) => t.days.length === 0) ? (
        <p className="text-sm text-muted-foreground">No snapshots yet. The first daily run only records a baseline; rows appear from the second.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Query</th>
                <th className="py-2 pr-3 font-medium">Rows / day</th>
                <th className="py-2 pr-3 text-right font-medium">Calls</th>
                <th className="py-2 pr-3 text-right font-medium">Rows</th>
                <th className="py-2 pr-3 text-right font-medium">Avg rows/call</th>
                <th className="py-2 text-right font-medium">Peak day</th>
              </tr>
            </thead>
            <tbody>
              {trends.map((t) => (
                <tr key={t.label} className="border-b border-border-subtle align-top">
                  <td className="py-2 pr-3">
                    <div className="font-medium text-foreground">{t.label}</div>
                    {t.days.length > 0 && (
                      <details className="mt-1 text-xs text-muted-foreground">
                        <summary className="cursor-pointer">{t.days.length} days</summary>
                        <table className="mt-1 tabular-nums">
                          <tbody>
                            {t.days.map((d) => (
                              <tr key={d.date}>
                                <td className="pr-3">{d.date}</td>
                                <td className="pr-3 text-right">{formatNumber(d.calls)} calls</td>
                                <td className="pr-3 text-right">{formatNumber(d.rows)} rows</td>
                                <td className="pr-3 text-right">avg {formatAvg(d.avgRows)}</td>
                                <td>{d.statsReset ? "(reset)" : ""}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </details>
                    )}
                  </td>
                  <td className="py-2 pr-3">{t.days.length > 0 ? <Sparkline values={t.days.map((d) => d.rows)} /> : <span className="text-muted-foreground">no data</span>}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-foreground">{formatNumber(t.totalCalls)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-foreground">{formatNumber(t.totalRows)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-foreground">{formatAvg(t.avgRows)}</td>
                  <td className="py-2 text-right tabular-nums text-foreground">{t.peak ? `${t.peak.date.slice(5)} (${formatNumber(t.peak.rows)})` : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
