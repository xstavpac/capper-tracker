// What the admin Generator tab shows of a stored run (parlay_generator_runs, written by
// lib/parlay/run-trace.ts): the funnel with a drop count and reasons at each stage, the
// flags worth a look (a stage that collapsed to 0, a count of exactly 50 / 100 / 1000 -
// the sizes a limit or a page would stop at), and the plain-text report behind
// "Copy for Claude". Pure: it reads a row, never the database.
import { REASON_LABELS, STAGE_CHAINS, type ReasonCode, type RunTrace, type StageKey } from "@/lib/parlay/run-trace";
import type { AdminReport } from "@/lib/admin-report";

export type RunRow = {
  id: string;
  createdAt: Date;
  mode: RunTrace["mode"];
  trigger: RunTrace["trigger"];
  origin: string;
  scoringVersion: string;
  settings: Record<string, unknown>;
  stages: RunTrace["stages"];
  reasons: RunTrace["reasons"];
  errors: RunTrace["errors"] | null;
  extras: (RunTrace["extras"] & Record<string, unknown>) | null;
  detailTruncated: boolean;
  traceFailed: boolean;
  durationMs: number | null;
};

// Counts a limit or a page size would stop at.
export const SUSPECT_COUNTS = [50, 100, 1000] as const;

export const STAGE_LABELS: Record<StageKey, string> = {
  POOL: "Pending picks in the snapshot",
  IN_SCOPE_GAMES: "In games the run draws from",
  NOT_SLIP: "Not already a slip pick",
  INCLUDED: "Passes Bet Types",
  HAS_RECORD: "Capper has a record for the bet",
  PASSES_GATE: "Clears the win-rate gate",
  NO_SLIP_CONFLICT: "No conflict with a slip pick",
  SELECTED: "Chosen as a leg",
  SLIP_TOTAL: "Slip picks",
  SLIP_LIVE: "Game not over",
  SLIP_NO_CONFLICT: "No duplicate / opposing pick",
  SLIP_FITS_GAME: "Within max legs per game",
  SLIP_USED: "Used in the parlay",
  HYB_GAMES_WITH_PICKS: "Games with pending picks",
  HYB_GAMES_KEPT: "Games in the parlay or its alternates",
};

export type RunFlag = "COLLAPSE" | "SUSPECT_COUNT";

export type FunnelRow = {
  stage: StageKey;
  label: string;
  count: number;
  // Previous stage's count in the chain, null on its first stage.
  previous: number | null;
  reasons: { reason: ReasonCode; label: string; sub?: string; count: number }[];
  flags: RunFlag[];
};

export type Funnel = { chain: keyof typeof STAGE_CHAINS; rows: FunnelRow[] };

const CHAIN_TITLES: Record<keyof typeof STAGE_CHAINS, string> = { pool: "Generated legs", slip: "Your slip", hybrid: "Games" };

export const chainTitle = (chain: keyof typeof STAGE_CHAINS) => CHAIN_TITLES[chain];

// The run's funnels, one per chain that has stages. A stage collapses when it falls to 0 from
// something; a count is suspect when it is exactly 50, 100 or 1000.
export function funnelsOf(run: Pick<RunRow, "stages" | "reasons">): Funnel[] {
  const count = new Map(run.stages.map((s) => [s.key, s.count]));
  const out: Funnel[] = [];
  for (const chain of Object.keys(STAGE_CHAINS) as (keyof typeof STAGE_CHAINS)[]) {
    const keys = STAGE_CHAINS[chain] as readonly StageKey[];
    const rows: FunnelRow[] = [];
    keys.forEach((stage, i) => {
      const n = count.get(stage);
      if (n === undefined) return;
      const previous = i === 0 ? null : (count.get(keys[i - 1]) ?? null);
      const flags: RunFlag[] = [];
      if (n === 0 && (previous ?? 0) > 0) flags.push("COLLAPSE");
      if ((SUSPECT_COUNTS as readonly number[]).includes(n)) flags.push("SUSPECT_COUNT");
      const reasons = run.reasons
        .filter((r) => r.stage === stage)
        .sort((a, b) => b.count - a.count)
        .map((r) => ({ reason: r.reason, label: REASON_LABELS[r.reason] ?? r.reason, ...(r.sub ? { sub: r.sub } : {}), count: r.count }));
      rows.push({ stage, label: STAGE_LABELS[stage] ?? stage, count: n, previous, reasons, flags });
    });
    if (rows.length > 0) out.push({ chain, rows });
  }
  return out;
}

// Counts outside the funnel that sit on a suspect size: the snapshot's intake.
export function suspectIntake(run: Pick<RunRow, "extras">): string[] {
  const out: string[] = [];
  const hit = (n: number) => (SUSPECT_COUNTS as readonly number[]).includes(n);
  for (const l of run.extras?.snapshot?.leagues ?? []) {
    if (hit(l.pickRowsFetched)) out.push(`${l.league}: ${l.pickRowsFetched} pick rows read`);
    if (hit(l.pickRowsMatched)) out.push(`${l.league}: ${l.pickRowsMatched} picks matched to a game`);
    if (hit(l.boardGames)) out.push(`${l.league}: ${l.boardGames} board games`);
  }
  const pool = run.extras?.snapshot?.poolPicks;
  if (pool !== undefined && hit(pool)) out.push(`${pool} pending picks in the pool`);
  return out;
}

// Scored with platform_category_rates empty: every pick on the 52% and -110 defaults.
export const noPlatformRates = (run: Pick<RunRow, "extras">): boolean => run.extras?.scoring?.platformRows === 0;

// Does anything in the run deserve a look?
export function runFlags(run: RunRow): { collapses: number; suspect: number; errors: number } {
  const funnels = funnelsOf(run);
  return {
    collapses: funnels.flatMap((f) => f.rows).filter((r) => r.flags.includes("COLLAPSE")).length,
    suspect: funnels.flatMap((f) => f.rows).filter((r) => r.flags.includes("SUSPECT_COUNT")).length + suspectIntake(run).length,
    errors: (run.errors?.length ?? 0) + (run.traceFailed ? 1 : 0),
  };
}

// Dropped picks (or games) by reason across the whole run.
export function reasonBreakdown(run: Pick<RunRow, "reasons">): { reason: ReasonCode; label: string; count: number }[] {
  const by = new Map<ReasonCode, number>();
  for (const r of run.reasons) by.set(r.reason, (by.get(r.reason) ?? 0) + r.count);
  return Array.from(by, ([reason, count]) => ({ reason, label: REASON_LABELS[reason] ?? reason, count })).sort((a, b) => b.count - a.count);
}

const MODE_LABEL: Record<RunRow["mode"], string> = { STANDARD: "Standard", YOUR_PICKS: "Your picks only", HYBRID: "Hybrid" };
export const modeLabel = (m: RunRow["mode"]) => MODE_LABEL[m] ?? m;

export function fmtUtc(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function settingsLine(settings: Record<string, unknown>): string {
  const parts: string[] = [];
  const s = (k: string) => settings[k];
  if (s("legCount") !== undefined) parts.push(`${s("legCount")} legs`);
  if (s("maxLegs") !== undefined) parts.push(`${s("maxLegs")} legs`);
  if (s("maxLegsPerGame") !== undefined) parts.push(`${s("maxLegsPerGame")}/game`);
  if (s("include") !== undefined) parts.push(`bets: ${Array.isArray(s("include")) ? (s("include") as string[]).join("+") : s("include")}`);
  if (s("minWinPct") !== undefined && s("minWinPct") !== null) parts.push(`gate ${s("minWinPct")}%`);
  if (s("fillFrom") !== undefined) parts.push(String(s("fillFrom")).toLowerCase().replace(/_/g, " "));
  if (s("boxLegs") !== undefined) parts.push(`box ${s("boxLegs")}`);
  if (Array.isArray(s("leagues"))) parts.push((s("leagues") as string[]).join("/") || "no league");
  if (typeof s("targets") === "number" && s("targets") !== 0) parts.push(`${s("targets")} targeted`);
  if (typeof s("slipPicks") === "number" && s("slipPicks") !== 0) parts.push(`${s("slipPicks")} slip picks`);
  return parts.join(" · ");
}

// The plain-text report behind "Copy for Claude" (admin-report.ts shape).
export function runsReport(runs: RunRow[], title = "Parlay Generator runs"): AdminReport {
  return {
    title,
    header: [`${runs.length} run${runs.length === 1 ? "" : "s"}, newest first. Counts only; per-pick detail is on the run's page.`],
    sections: [
      {
        items: runs.map((run) => {
          const f = runFlags(run);
          const flags: string[] = [];
          if (f.collapses > 0) flags.push(`${f.collapses} stage${f.collapses === 1 ? "" : "s"} collapsed to 0`);
          if (f.suspect > 0) flags.push(`${f.suspect} count${f.suspect === 1 ? "" : "s"} of exactly 50 / 100 / 1000`);
          for (const e of run.errors ?? []) flags.push(`${e.code}${e.where ? ` (${e.where})` : ""}: ${e.message}`);
          if (run.traceFailed) flags.push("TRACE_ERROR: the funnel may be incomplete");
          if (noPlatformRates(run)) flags.push("platform_category_rates was empty: every pick scored on the defaults");
          const lines: string[] = [`scoring ${run.scoringVersion} · ${run.origin.toLowerCase()} · ${run.durationMs ?? "?"}ms · ${settingsLine(run.settings)}`];
          for (const funnel of funnelsOf(run)) {
            lines.push(`${chainTitle(funnel.chain)}: ` + funnel.rows.map((r) => `${r.stage} ${r.count}`).join(" > "));
            for (const row of funnel.rows) for (const r of row.reasons) lines.push(`  dropped at ${row.stage}: ${r.reason}${r.sub ? ` [${r.sub}]` : ""} x${r.count}`);
          }
          if (run.extras?.scoring) lines.push(`platform rates: ${run.extras.scoring.platformRows} rows`);
          for (const l of run.extras?.scoring?.legs ?? [])
            lines.push(`scored ${l.role} ${l.id}: ${l.model}${l.fallback ? `/${l.fallback}` : ""} level ${l.level ?? "-"} tier ${l.tier ?? "-"} win ${l.shrunkWin ?? "-"} edge ${l.edge ?? "-"} shrunkEdge ${l.shrunkEdge ?? "-"} price ${l.price ?? "-"} gate ${l.gatePass ?? "-"}`);
          for (const note of run.extras?.notes ?? []) lines.push(`note: ${note}`);
          for (const l of run.extras?.ladders ?? []) lines.push(`ladder ${l.gameLabel}: ${l.status}${l.cause ? ` (${l.cause})` : ""}`);
          for (const l of run.extras?.snapshot?.leagues ?? [])
            lines.push(`intake ${l.league}: ${l.boardGames} board games, ${l.pickRowsFetched} pick rows read, ${l.pickRowsMatched} matched, ${l.pickRowsUnmatched} unmatched, ${l.matchedPending} pending, ${l.gamesKept} games kept`);
          return { title: `${fmtUtc(run.createdAt)} · ${modeLabel(run.mode)} · ${run.trigger.toLowerCase()}`, flags, lines };
        }),
        empty: "No runs yet.",
      },
    ],
  };
}
