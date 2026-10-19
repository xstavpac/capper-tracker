import { IMPORT_ALERT_STAGES, IMPORT_LISTED_STAGES } from "@/lib/admin-thresholds";
import { shortId, type AdminReport } from "@/lib/admin-report";

// Pure half of the ops console's Imports tab (last IMPORT_WINDOW_HOURS):
// picks inserted with no matched game, how ambiguous team names were
// settled, and the lines the importer couldn't read - plus the red dot.
// Reads/writes: server/data/import-runs.ts.

// How the browser settled one ambiguous team name in a paste (the
// ambiguous-hierarchy's method, or "user" when the import asked).
export const AMBIGUITY_METHODS = ["schedule", "season", "pick_context", "remembered", "user", "plausibility", "league_activity"] as const;
export type AmbiguityMethod = (typeof AMBIGUITY_METHODS)[number];
export type ImportAmbiguityEntry = { key: string; sport: string; method: AmbiguityMethod; count: number };

const MAX_AMBIGUITY_ENTRIES = 100;

// The ambiguity log comes from the browser: keep only well-formed entries,
// clipped and capped.
export function sanitizeAmbiguityLog(raw: unknown): ImportAmbiguityEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ImportAmbiguityEntry[] = [];
  for (const e of raw.slice(0, MAX_AMBIGUITY_ENTRIES)) {
    if (!e || typeof e !== "object") continue;
    const { key, sport, method, count } = e as Record<string, unknown>;
    if (typeof key !== "string" || typeof sport !== "string" || !AMBIGUITY_METHODS.includes(method as AmbiguityMethod)) continue;
    const n = typeof count === "number" && Number.isInteger(count) && count > 0 ? Math.min(count, 10000) : null;
    if (n === null || !key.trim()) continue;
    out.push({ key: key.slice(0, 60), sport: sport.slice(0, 40), method: method as AmbiguityMethod, count: n });
  }
  return out;
}

// A pick inserted with no matched game: its sport has no score source, so
// it got the bet text as its "home team", "-" as its opponent and the import
// time as its game time (resolveGameAndOdds' placeholders).
export type FallbackPick = { pickId: string; sport: string; betDetail: string };

export type SkippedLineRow = {
  id: string;
  stage: string;
  capperName: string;
  rawText: string;
  guessedSport: string | null;
  reason: string | null;
  createdAt: Date;
};

export type ImportsView = {
  now: Date;
  windowHours: number;
  byStage: { stage: string; count: number }[];
  lines: SkippedLineRow[]; // newest first, alerting + listed stages
  runs: { runs: number; items: number; inserted: number; skipped: number; fallback: number; ambiguousAuto: number; ambiguousAsked: number };
  fallbackPicks: FallbackPick[];
  ambiguity: ImportAmbiguityEntry[];
};

export const isAlertStage = (stage: string) => (IMPORT_ALERT_STAGES as readonly string[]).includes(stage);
export const isListedStage = (stage: string) => (IMPORT_LISTED_STAGES as readonly string[]).includes(stage);

// The Imports tab's red dot.
export function importsAlert(counts: { failed: number; fallback: number }, windowHours: number): string | null {
  const parts: string[] = [];
  if (counts.failed > 0) parts.push(`${counts.failed} unmatched or unreadable line${counts.failed === 1 ? "" : "s"}`);
  if (counts.fallback > 0) parts.push(`${counts.fallback} pick${counts.fallback === 1 ? "" : "s"} imported with no matched game`);
  return parts.length ? `${parts.join(", ")} in the last ${windowHours}h` : null;
}

export function alertCounts(v: Pick<ImportsView, "byStage" | "runs">): { failed: number; fallback: number } {
  return { failed: v.byStage.filter((s) => isAlertStage(s.stage)).reduce((n, s) => n + s.count, 0), fallback: v.runs.fallback };
}

// "Copy for Claude" for the Imports tab. Raw lines and bet text included; no
// user ids (capper names are the paste's own headers).
export function importsReport(v: ImportsView): AdminReport {
  const fmt = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const counts = alertCounts(v);
  return {
    title: `Imports report - last ${v.windowHours}h (import_runs + import_skipped_lines)`,
    header: [
      `As of ${fmt(v.now)}. Imports: ${v.runs.runs}, lines submitted ${v.runs.items}, picks inserted ${v.runs.inserted}, skipped ${v.runs.skipped}.`,
      `No matched game: ${counts.fallback} inserted with the import time as game time, ${v.byStage.find((s) => s.stage === "GAME_UNMATCHED")?.count ?? 0} refused (GAME_UNMATCHED). Ambiguous team names: ${v.runs.ambiguousAuto} settled automatically, ${v.runs.ambiguousAsked} asked.`,
      `Skipped lines by stage: ${v.byStage.map((s) => `${s.stage} ${s.count}`).join(", ") || "none"}. Red-dot stages: ${IMPORT_ALERT_STAGES.join(", ")}; listed only: ${IMPORT_LISTED_STAGES.join(", ")}.`,
    ],
    sections: [
      {
        heading: "Picks inserted with no matched game",
        empty: "none",
        items: v.fallbackPicks.map((f) => ({ title: `${f.sport} - ${f.betDetail}`, flags: ["no matched game: game time = import time"], lines: [`pick ${shortId(f.pickId)}`] })),
      },
      {
        heading: "Unmatched / unreadable lines (newest first)",
        empty: "none",
        items: v.lines.map((l) => ({
          title: `${l.stage} - ${l.rawText}`,
          flags: isAlertStage(l.stage) ? [l.reason ?? l.stage] : [],
          lines: [`capper "${l.capperName}"${l.guessedSport ? `, sport ${l.guessedSport}` : ""}, ${fmt(l.createdAt)}${!isAlertStage(l.stage) && l.reason ? ` - ${l.reason}` : ""}`],
        })),
      },
      {
        heading: "Ambiguous team names",
        empty: "none",
        items: v.ambiguity.map((a) => ({ title: `"${a.key}" -> ${a.sport}`, lines: [`${a.method === "user" ? "asked the user" : `settled by ${a.method}`}, ${a.count} pick${a.count === 1 ? "" : "s"}`] })),
      },
    ],
  };
}
