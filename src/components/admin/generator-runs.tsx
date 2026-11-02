import Link from "next/link";
import { REASON_LABELS, type ReasonCode, type SwapLegTrace, type SwapModeTrace } from "@/lib/parlay/run-trace";
import { chainTitle, fmtUtc, funnelsOf, modeLabel, noPlatformRates, reasonBreakdown, runFlags, settingsLine, suspectIntake, type RunRow } from "@/lib/parlay/run-view";
import type { RunTrace } from "@/lib/parlay/run-trace";

// The admin Generator tab's markup: no state, no client code, so the page is the
// whole thing and a test can render it. Counts and reasons come from a stored run
// (run-view.ts); per-pick detail only on a run's own page.

const RED = "bg-[#FDECEC] dark:bg-[#DC2626]/15";
const AMBER = "bg-[#FEF3C7] dark:bg-[#F59E0B]/15";
const RED_TEXT = "text-[#B91C1C] dark:text-[#F87171]";
const DETAIL_DAYS = 30;

function Badge({ children, tone }: { children: React.ReactNode; tone: "red" | "amber" | "muted" }) {
  const cls = tone === "red" ? `${RED} ${RED_TEXT}` : tone === "amber" ? `${AMBER} text-foreground` : "bg-muted text-muted-foreground";
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

export function RunsList({ runs, selected }: { runs: RunRow[]; selected?: string }) {
  if (runs.length === 0) return <p className="text-sm text-muted-foreground">No runs yet. Generate a parlay and reload.</p>;
  return (
    <ul className="space-y-3">
      {runs.map((run) => (
        <li key={run.id}>
          <RunCard run={run} open={run.id === selected} />
        </li>
      ))}
    </ul>
  );
}

function RunCard({ run, open = false }: { run: RunRow; open?: boolean }) {
  const flags = runFlags(run);
  const funnels = funnelsOf(run);
  const breakdown = reasonBreakdown(run);
  const intake = suspectIntake(run);
  const hasDetail = run.trigger !== "REGENERATE" && Date.now() - run.createdAt.getTime() < DETAIL_DAYS * 86400_000;
  return (
    <details open={open} className="rounded-lg border border-border-subtle p-3 text-sm">
      <summary className="cursor-pointer">
        <span className="font-medium text-foreground">{fmtUtc(run.createdAt)}</span>
        <span className="ml-2 text-foreground">{modeLabel(run.mode)}</span>
        <span className="ml-2 text-muted-foreground">{run.trigger.toLowerCase()} · {run.origin.toLowerCase()}</span>
        <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
          {flags.errors > 0 && <Badge tone="red">{flags.errors} error{flags.errors === 1 ? "" : "s"}</Badge>}
          {flags.collapses > 0 && <Badge tone="red">collapsed to 0</Badge>}
          {flags.suspect > 0 && <Badge tone="amber">50 / 100 / 1000</Badge>}
          {noPlatformRates(run) && <Badge tone="red">no platform rates</Badge>}
          {run.detailTruncated && <Badge tone="muted">detail truncated</Badge>}
        </span>
        <div className="mt-0.5 text-xs text-muted-foreground">{settingsLine(run.settings)}</div>
      </summary>

      <div className="mt-3 space-y-4">
        <p className="text-xs text-muted-foreground">
          scoring <span className="font-mono">{run.scoringVersion}</span> · {run.durationMs ?? "?"} ms
          {run.extras?.scoring && <> · platform rates: {run.extras.scoring.platformRows} rows</>}
          {hasDetail && (
            <>
              {" · "}
              <Link href={`/admin/generator?run=${run.id}`} className="text-foreground underline underline-offset-2">
                per-pick detail
              </Link>
            </>
          )}
        </p>

        {(run.errors ?? []).length > 0 && (
          <ul className="space-y-1">
            {(run.errors ?? []).map((e, i) => (
              <li key={i} className={`rounded px-2 py-1 ${RED} ${RED_TEXT}`}>
                <span className="font-mono text-xs">{e.code}</span>
                {e.where ? ` (${e.where})` : ""}: {e.message}
              </li>
            ))}
          </ul>
        )}
        {run.traceFailed && <p className={`rounded px-2 py-1 ${RED} ${RED_TEXT}`}>The trace itself failed - the funnel below may be incomplete.</p>}

        {funnels.map((f) => (
          <section key={f.chain} className="space-y-1">
            <h3 className="text-sm font-semibold text-foreground">{chainTitle(f.chain)}</h3>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <tbody>
                  {f.rows.map((r) => {
                    const collapsed = r.flags.includes("COLLAPSE");
                    const suspect = r.flags.includes("SUSPECT_COUNT");
                    return (
                      <tr key={r.stage} className={`border-b border-border-subtle align-top ${collapsed ? RED : suspect ? AMBER : ""}`}>
                        <td className="py-1.5 pl-1 pr-3 text-foreground">
                          {r.label}
                          <div className="font-mono text-[11px] text-muted-foreground">{r.stage}</div>
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums text-foreground">
                          {r.count}
                          {collapsed && <div className={`text-xs ${RED_TEXT}`}>collapsed to 0</div>}
                          {suspect && <div className="text-xs text-muted-foreground">exactly {r.count}</div>}
                        </td>
                        <td className="py-1.5 pr-1 text-xs text-muted-foreground">
                          {r.reasons.length === 0
                            ? r.previous === null
                              ? ""
                              : "none dropped"
                            : r.reasons.map((x) => (
                                <div key={x.reason + (x.sub ?? "")}>
                                  −{x.count} {x.label}
                                  {x.sub ? <span className="text-muted-foreground"> ({x.sub})</span> : null}
                                </div>
                              ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))}
        {funnels.length === 0 && <p className="text-muted-foreground">This run recorded no stages.</p>}

        {intake.length > 0 && <p className={`rounded px-2 py-1 text-xs ${AMBER}`}>Intake at exactly 50 / 100 / 1000: {intake.join("; ")}.</p>}
        <Intake run={run} />
        <Ladders run={run} />
        {breakdown.length > 0 && (
          <section className="space-y-1">
            <h3 className="text-sm font-semibold text-foreground">Dropped by reason</h3>
            <ul className="text-xs text-foreground">
              {breakdown.map((b) => (
                <li key={b.reason} className="flex justify-between gap-3 border-b border-border-subtle py-1 sm:max-w-md">
                  <span>{b.label}</span>
                  <span className="tabular-nums">{b.count}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {(run.extras?.notes ?? []).length > 0 && <p className="text-xs text-muted-foreground">{(run.extras?.notes ?? []).join(" · ")}</p>}
      </div>
    </details>
  );
}

function Intake({ run }: { run: RunRow }) {
  const leagues = run.extras?.snapshot?.leagues ?? [];
  if (leagues.length === 0) return null;
  return (
    <section className="space-y-1">
      <h3 className="text-sm font-semibold text-foreground">Intake (what the snapshot read)</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-xs">
          <thead>
            <tr className="border-b border-border text-left uppercase tracking-wide text-muted-foreground">
              <th className="py-1 pr-2 font-medium">League</th>
              <th className="py-1 pr-2 text-right font-medium">Board games</th>
              <th className="py-1 pr-2 text-right font-medium">Pick rows read</th>
              <th className="py-1 pr-2 text-right font-medium">Matched</th>
              <th className="py-1 pr-2 text-right font-medium">Unmatched</th>
              <th className="py-1 pr-2 text-right font-medium">Pending</th>
              <th className="py-1 text-right font-medium">Games kept</th>
            </tr>
          </thead>
          <tbody>
            {leagues.map((l) => (
              <tr key={l.league} className="border-b border-border-subtle tabular-nums text-foreground">
                <td className="py-1 pr-2">{l.league}</td>
                <td className="py-1 pr-2 text-right">{l.boardGames}</td>
                <td className="py-1 pr-2 text-right">{l.pickRowsFetched}</td>
                <td className="py-1 pr-2 text-right">{l.pickRowsMatched}</td>
                <td className="py-1 pr-2 text-right">{l.pickRowsUnmatched}</td>
                <td className="py-1 pr-2 text-right">{l.matchedPending}</td>
                <td className="py-1 text-right">{l.gamesKept}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Ladders({ run }: { run: RunRow }) {
  const ladders = run.extras?.ladders ?? [];
  if (ladders.length === 0) return null;
  return (
    <section className="space-y-1">
      <h3 className="text-sm font-semibold text-foreground">FanDuel lines per priced game</h3>
      <ul className="text-xs">
        {ladders.map((l) => (
          <li key={l.eventId} className={`flex flex-wrap justify-between gap-2 border-b border-border-subtle px-1 py-1 ${l.status === "ok" ? "" : l.status === "unavailable" ? RED : AMBER}`}>
            <span className="text-foreground">{l.gameLabel}</span>
            <span className="text-muted-foreground">
              {l.status}
              {l.cause ? ` (${l.cause})` : ""} · {l.markets.join(", ")}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// One run in full: Hedge / Contrarian per leg, the intake per game, and every
// dropped pick under its stage and reason.
// ---------------------------------------------------------------------------
export function RunDetailView({ run }: { run: RunRow & { detail: RunTrace["detail"] } }) {
  const d = run.detail;
  const swaps = (run.extras?.swaps ?? []).filter((m) => m.legs.length > 0);
  const games = run.extras?.snapshot?.games ?? [];
  const groups = new Map<string, { stage: string; reason: ReasonCode; items: { label: string; sub?: string }[] }>();
  for (const [i, stage, reason, sub] of d?.drops ?? []) {
    const key = stage + "|" + reason;
    const g = groups.get(key) ?? { stage, reason, items: [] };
    g.items.push({ label: d!.picks[i]?.label ?? "?", ...(sub ? { sub } : {}) });
    groups.set(key, g);
  }
  return (
    <div className="space-y-6">
      <RunCard run={run} open />
      {swaps.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-foreground">Hedge and Contrarian, leg by leg (Swap = All)</h2>
          {swaps.map((m) => (
            <SwapTable key={m.mode + m.scope} mode={m} />
          ))}
        </section>
      )}
      {(run.extras?.scoring?.legs ?? []).length > 0 && (
        <section className="space-y-1">
          <h2 className="text-lg font-semibold text-foreground">Scoring, leg by leg</h2>
          <ul className="text-xs">
            {run.extras!.scoring!.legs.map((l) => (
              <li key={l.role + l.id} className="flex flex-wrap justify-between gap-2 border-b border-border-subtle px-1 py-1">
                <span className="font-mono text-foreground">{l.role} · {l.id}</span>
                <span className="text-muted-foreground">
                  {l.model}{l.fallback ? ` / ${l.fallback}` : ""} · {l.level ?? "-"} · {l.tier ?? "-"} · win {l.shrunkWin ?? "-"} · edge {l.edge ?? "-"} · shrunk edge {l.shrunkEdge ?? "-"} · {l.price ?? "-"} · needs {l.requiredEdge ?? "no gate"} · {l.gatePass === undefined ? "-" : l.gatePass ? "passes" : "fails"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {games.length > 0 && (
        <section className="space-y-1">
          <h2 className="text-lg font-semibold text-foreground">Games in the intake</h2>
          <ul className="text-xs">
            {games.map(([league, label, matched, pending, why], i) => (
              <li key={i} className={`flex flex-wrap justify-between gap-2 border-b border-border-subtle px-1 py-1 ${why === "kept" ? "" : AMBER}`}>
                <span className="text-foreground">{league} · {label}</span>
                <span className="text-muted-foreground">{matched} matched · {pending} pending · {why}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Dropped picks</h2>
        {!d ? (
          <p className="text-sm text-muted-foreground">No per-pick detail for this run (a Regenerate keeps counts only, and detail is cleared after {DETAIL_DAYS} days).</p>
        ) : groups.size === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing was dropped one pick at a time.</p>
        ) : (
          Array.from(groups.values()).map((g) => (
            <div key={g.stage + g.reason}>
              <h3 className="text-sm font-semibold text-foreground">
                {REASON_LABELS[g.reason] ?? g.reason} <span className="font-mono text-xs text-muted-foreground">{g.stage}</span> · {g.items.length}
              </h3>
              <ul className="mt-1 text-xs text-foreground">
                {g.items.slice(0, 200).map((it, i) => (
                  <li key={i} className="border-b border-border-subtle py-1">
                    {it.label}
                    {it.sub ? <span className="text-muted-foreground"> ({it.sub})</span> : null}
                  </li>
                ))}
                {g.items.length > 200 && <li className="py-1 text-muted-foreground">… {g.items.length - 200} more</li>}
              </ul>
            </div>
          ))
        )}
        {run.detailTruncated && <p className={`rounded px-2 py-1 text-xs ${AMBER}`}>Detail was capped; the counts above are complete, the list is not.</p>}
      </section>
    </div>
  );
}

function SwapTable({ mode }: { mode: SwapModeTrace }) {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-semibold text-foreground">
        {mode.mode === "AUTO_HEDGE" ? "Hedge" : "Contrarian"} · {mode.swapCount} of {mode.legs.length} legs swapped
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-xs">
          <thead>
            <tr className="border-b border-border text-left uppercase tracking-wide text-muted-foreground">
              <th className="py-1 pr-2 font-medium">Leg</th>
              <th className="py-1 pr-2 font-medium">Result</th>
              <th className="py-1 pr-2 text-right font-medium">On game</th>
              <th className="py-1 pr-2 font-medium">Left out before the classifier</th>
              <th className="py-1 pr-2 font-medium">Classifier</th>
              <th className="py-1 font-medium">Paired → record</th>
            </tr>
          </thead>
          <tbody>
            {mode.legs.map((l) => (
              <SwapRow key={l.pick.id} leg={l} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SwapRow({ leg }: { leg: SwapLegTrace }) {
  const ex = leg.excluded;
  const excluded = [ex.FILTER_BET_TYPE && `${ex.FILTER_BET_TYPE} Bet Types`, ex.IN_SLIP && `${ex.IN_SLIP} in your slip`, ex.ALREADY_IN_PARLAY && `${ex.ALREADY_IN_PARLAY} already a leg`, ex.SAME_GAME_CONFLICT && `${ex.SAME_GAME_CONFLICT} same-game rule`].filter(Boolean);
  const swapped = leg.result === "SWAPPED";
  return (
    <tr className={`border-b border-border-subtle align-top ${swapped ? "" : AMBER}`}>
      <td className="py-1 pr-2 text-foreground">{leg.pick.label}</td>
      <td className="py-1 pr-2 text-foreground">{swapped ? `swapped (${leg.rule})` : (REASON_LABELS[leg.result as ReasonCode] ?? leg.result)}</td>
      <td className="py-1 pr-2 text-right tabular-nums text-foreground">{leg.gamePicks}</td>
      <td className="py-1 pr-2 text-muted-foreground">{excluded.length ? excluded.join(", ") : "—"}</td>
      <td className="py-1 pr-2 font-mono text-muted-foreground">
        {Object.entries(leg.classifier).map(([k, n]) => `${k}×${n}`).join(" ") || "—"}
      </td>
      <td className="py-1 text-muted-foreground">
        {leg.paired} paired · {leg.noRecord} no record · {leg.belowGate} below gate · {leg.qualified} qualified
      </td>
    </tr>
  );
}
