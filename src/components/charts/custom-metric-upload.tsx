"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  parseCsv,
  detectDateColumn,
  detectTeamColumn,
  detectValueCandidates,
  buildImportRows,
  buildSnapshotRows,
  findDuplicateKeys,
  findDuplicateTeams,
  resolveDuplicates,
  resolveDuplicateTeams,
  type ParsedCsv,
  type ImportRow,
  type SnapshotImportRow,
  type RowError,
} from "@/lib/csv-metric-import";
import { importCustomMetricsAction } from "@/server/actions/custom-metrics";
import type { MetricImportSpec } from "@/server/data/custom-metrics";

const NO_TEAM = "__none__";
const PREVIEW_ROW_COUNT = 5;

type Step = "upload" | "review" | "importing" | "done";

// "daily" is the original dated time-series import. "snapshot" is offered
// when the CSV has no date column: the numbers already represent a whole
// season, so instead of forcing a fake date the user gives the period a
// label ("2026 Season") and the metric is stored/charted as a per-team
// aggregate. See lib/csv-metric-import.ts.
type ImportMode = "daily" | "snapshot";

type MetricSelection = {
  column: string;
  selected: boolean;
  name: string;
};

export function CustomMetricUpload({ sportKey, onClose }: { sportKey: string; onClose: () => void }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("upload");
  const [dragOver, setDragOver] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>("daily");
  const [dateColumn, setDateColumn] = useState<string>("");
  const [teamColumn, setTeamColumn] = useState<string>(NO_TEAM);
  const [periodLabel, setPeriodLabel] = useState<string>("");
  const [manualRemap, setManualRemap] = useState(false);
  const [metricSelections, setMetricSelections] = useState<MetricSelection[]>([]);
  const [duplicateStrategy, setDuplicateStrategy] = useState<"first" | "last" | null>(null);

  const [importError, setImportError] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<{ name: string; pointCount: number }[] | null>(null);

  function reset() {
    setStep("upload");
    setParsed(null);
    setImportMode("daily");
    setDateColumn("");
    setTeamColumn(NO_TEAM);
    setPeriodLabel("");
    setManualRemap(false);
    setMetricSelections([]);
    setDuplicateStrategy(null);
    setFileError(null);
    setImportError(null);
    setImportSummary(null);
  }

  async function handleFile(file: File) {
    setFileError(null);
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setFileError("Please upload a .csv file.");
      return;
    }
    const text = await file.text();
    const result = parseCsv(text);
    if (result.headers.length === 0 || result.rows.length === 0) {
      setFileError("Couldn't find any columns or rows in this file.");
      return;
    }

    const detectedDate = detectDateColumn(result.headers);
    const detectedTeam = detectTeamColumn(result.headers);
    const candidates = detectValueCandidates(result, detectedDate, detectedTeam);

    setParsed(result);
    // No date column -> default to offering a Season Snapshot rather than
    // landing on the blocked daily flow. The user can still switch back to
    // daily + Fix Columns Manually if a date column was just named oddly.
    setImportMode(detectedDate ? "daily" : "snapshot");
    setDateColumn(detectedDate ?? "");
    setTeamColumn(detectedTeam ?? NO_TEAM);
    setPeriodLabel("");
    // Exactly one candidate -> pre-selected, per the auto-detection rule.
    // More than one -> none pre-selected, so an accidental "import
    // everything" can't happen; the user has to actively pick.
    setMetricSelections(
      candidates.map((col) => ({ column: col, selected: candidates.length === 1, name: col }))
    );
    setDuplicateStrategy(null);
    setStep("review");
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  const hasTeamColumn = teamColumn !== NO_TEAM;
  const isSnapshot = importMode === "snapshot";

  // ---- Daily-mode derived rows (unchanged behavior) ----------------------
  const daily = useMemo(() => {
    if (isSnapshot || !parsed || !dateColumn) return { rows: [] as ImportRow[], errors: [] as RowError[] };
    return buildImportRows(parsed, {
      dateColumn,
      teamColumn: hasTeamColumn ? teamColumn : null,
      valueColumns: metricSelections.filter((m) => m.selected).map((m) => m.column),
    });
  }, [isSnapshot, parsed, dateColumn, teamColumn, hasTeamColumn, metricSelections]);

  // ---- Snapshot-mode derived rows ---------------------------------------
  const snapshot = useMemo(() => {
    if (!isSnapshot || !parsed || !hasTeamColumn) return { rows: [] as SnapshotImportRow[], errors: [] as RowError[] };
    return buildSnapshotRows(parsed, {
      teamColumn,
      valueColumns: metricSelections.filter((m) => m.selected).map((m) => m.column),
    });
  }, [isSnapshot, parsed, hasTeamColumn, teamColumn, metricSelections]);

  const rowErrors = isSnapshot ? snapshot.errors : daily.errors;

  const dailyDuplicates = useMemo(() => (isSnapshot ? [] : findDuplicateKeys(daily.rows)), [isSnapshot, daily.rows]);
  const snapshotDuplicates = useMemo(
    () => (isSnapshot ? findDuplicateTeams(snapshot.rows) : []),
    [isSnapshot, snapshot.rows]
  );
  const duplicateCount = isSnapshot ? snapshotDuplicates.length : dailyDuplicates.length;

  const effectiveDailyRows = useMemo(() => {
    if (dailyDuplicates.length === 0 || !duplicateStrategy) return daily.rows;
    return resolveDuplicates(daily.rows, duplicateStrategy);
  }, [daily.rows, dailyDuplicates.length, duplicateStrategy]);

  const effectiveSnapshotRows = useMemo(() => {
    if (snapshotDuplicates.length === 0 || !duplicateStrategy) return snapshot.rows;
    return resolveDuplicateTeams(snapshot.rows, duplicateStrategy);
  }, [snapshot.rows, snapshotDuplicates.length, duplicateStrategy]);

  const selectedMetrics = metricSelections.filter((m) => m.selected);
  const hasBlockingDuplicates = duplicateCount > 0 && !duplicateStrategy;
  const hasValueErrors = rowErrors.some((e) => e.reason === "invalid_value");
  const hasDateErrors = rowErrors.some((e) => e.reason === "invalid_date");
  const snapshotNeedsTeam = isSnapshot && !hasTeamColumn;
  const snapshotNeedsLabel = isSnapshot && periodLabel.trim() === "";

  const canImport =
    step === "review" &&
    selectedMetrics.length > 0 &&
    !hasBlockingDuplicates &&
    !hasValueErrors &&
    (isSnapshot
      ? !snapshotNeedsTeam && !snapshotNeedsLabel
      : !!dateColumn && !hasDateErrors);

  async function handleImport() {
    if (!canImport || !parsed) return;
    setStep("importing");
    setImportError(null);
    try {
      const specs: MetricImportSpec[] = selectedMetrics.map((m) =>
        isSnapshot
          ? {
              kind: "snapshot" as const,
              name: m.name.trim() || m.column,
              periodLabel: periodLabel.trim(),
              rows: effectiveSnapshotRows,
              valueColumn: m.column,
            }
          : {
              name: m.name.trim() || m.column,
              hasTeamColumn,
              rows: effectiveDailyRows,
              valueColumn: m.column,
            }
      );
      const results = await importCustomMetricsAction(sportKey, specs);
      setImportSummary(results.map((r) => ({ name: r.name, pointCount: r.pointCount })));
      setStep("done");
      router.refresh();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed.");
      setStep("review");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-card bg-card p-6 shadow-soft"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">Add Custom Metric</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close">
            ✕
          </button>
        </div>

        {step === "upload" && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={
              "flex h-48 flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed text-sm transition " +
              (dragOver ? "border-brand-400 bg-brand-50 dark:bg-brand-500/10" : "border-border text-muted-foreground")
            }
          >
            <p>Drag and drop a CSV file here, or</p>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="rounded-full bg-brand-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-brand-700"
            >
              Choose file
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
                e.target.value = "";
              }}
            />
            {fileError && <p className="text-xs text-red-500 dark:text-red-400">{fileError}</p>}
          </div>
        )}

        {step === "review" && parsed && (
          <div className="space-y-4">
            {/* No date column: offer the snapshot path instead of dead-ending
                on the blocked daily flow. */}
            {!dateColumn && (
              <div className="rounded-lg border border-brand-200 bg-brand-50 p-3 text-sm dark:border-brand-500/30 dark:bg-brand-500/10">
                <p className="mb-1 font-medium text-foreground">No date column found</p>
                <p className="mb-2 text-xs text-muted-foreground">
                  {isSnapshot
                    ? "This is being imported as a Season Snapshot — one value per team for a whole period, charted as a bar comparison in Team Comparison. If your file really does have dates, switch back and map the column manually."
                    : "If every row is a season/period total rather than a single day, import it as a Season Snapshot — no date needed."}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => {
                      setImportMode(isSnapshot ? "daily" : "snapshot");
                      setDuplicateStrategy(null);
                    }}
                    className="rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white transition hover:bg-brand-700"
                  >
                    {isSnapshot ? "Import as dated daily metric instead" : "Import as Season Snapshot"}
                  </button>
                  {!isSnapshot && (
                    <button
                      onClick={() => setManualRemap(true)}
                      className="text-xs text-brand-600 hover:underline dark:text-brand-400"
                    >
                      Or map a date column manually
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="rounded-lg bg-muted p-3 text-sm">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-medium text-foreground">
                  {isSnapshot ? "Season Snapshot — detected columns" : "Detected columns"}
                </span>
                <button onClick={() => setManualRemap((v) => !v)} className="text-xs text-brand-600 hover:underline dark:text-brand-400">
                  {manualRemap ? "Hide manual remap" : "Fix Columns Manually"}
                </button>
              </div>

              <div className="space-y-1.5 text-xs">
                {!isSnapshot && (
                  <div className="flex items-center gap-2">
                    <span className={dateColumn ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}>
                      {dateColumn ? "✓" : "✗"}
                    </span>
                    <span className="text-muted-foreground">Date column:</span>
                    {manualRemap ? (
                      <select value={dateColumn} onChange={(e) => setDateColumn(e.target.value)} className="rounded border border-border bg-card px-1.5 py-0.5">
                        <option value="">Select...</option>
                        {parsed.headers.map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="font-medium text-foreground">{dateColumn || "not found - use Fix Columns Manually"}</span>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <span
                    className={
                      isSnapshot && !hasTeamColumn
                        ? "text-red-500 dark:text-red-400"
                        : "text-emerald-600 dark:text-emerald-400"
                    }
                  >
                    {isSnapshot && !hasTeamColumn ? "✗" : "✓"}
                  </span>
                  <span className="text-muted-foreground">Team column{isSnapshot ? " (required)" : ""}:</span>
                  {manualRemap ? (
                    <select value={teamColumn} onChange={(e) => setTeamColumn(e.target.value)} className="rounded border border-border bg-card px-1.5 py-0.5">
                      <option value={NO_TEAM}>{isSnapshot ? "None" : "None - global metric"}</option>
                      {parsed.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="font-medium text-foreground">
                      {hasTeamColumn
                        ? teamColumn
                        : isSnapshot
                          ? "none found - use Fix Columns Manually to pick one"
                          : "none found - metric will apply to every team"}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {isSnapshot && (
              <div className="rounded-lg bg-muted p-3 text-sm">
                <label className="mb-1 block font-medium text-foreground">Period this snapshot covers</label>
                <input
                  value={periodLabel}
                  onChange={(e) => setPeriodLabel(e.target.value)}
                  placeholder="e.g. 2026 Season"
                  className="w-full rounded border border-border bg-card px-2 py-1 text-sm"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  A label, not a date — shown on the chart in place of a timeline.
                </p>
              </div>
            )}

            <div className="rounded-lg bg-muted p-3 text-sm">
              <div className="mb-2 font-medium text-foreground">
                {metricSelections.length > 1 ? "Which metric(s) do you want to import?" : "Metric to import"}
              </div>
              <div className="space-y-2">
                {metricSelections.map((m, i) => (
                  <div key={m.column} className="flex flex-wrap items-center gap-2">
                    <input
                      type="checkbox"
                      checked={m.selected}
                      onChange={(e) =>
                        setMetricSelections((prev) => prev.map((p, j) => (j === i ? { ...p, selected: e.target.checked } : p)))
                      }
                    />
                    <span className="text-xs text-muted-foreground">from column &ldquo;{m.column}&rdquo; -&gt;</span>
                    <input
                      value={m.name}
                      onChange={(e) => setMetricSelections((prev) => prev.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)))}
                      className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 text-sm"
                      placeholder="Metric name"
                    />
                  </div>
                ))}
                {metricSelections.length === 0 && (
                  <p className="text-xs text-red-500 dark:text-red-400">
                    No numeric columns found to import - use Fix Columns Manually if the date/team columns were detected incorrectly.
                  </p>
                )}
              </div>
            </div>

            {parsed.rows.length > 0 && (
              <div className="overflow-x-auto rounded-lg bg-muted p-3">
                <div className="mb-2 text-xs font-medium text-foreground">Preview (first {Math.min(PREVIEW_ROW_COUNT, parsed.rows.length)} rows)</div>
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      {parsed.headers.map((h) => (
                        <th key={h} className="pr-4 pb-1 font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.rows.slice(0, PREVIEW_ROW_COUNT).map((row, i) => (
                      <tr key={i} className="text-foreground">
                        {parsed.headers.map((h) => (
                          <td key={h} className="pr-4 py-0.5">
                            {row[h]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {snapshotNeedsTeam && (
              <div className="rounded-lg bg-red-50 p-3 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-400">
                A Season Snapshot needs a team column (its values are per team). Use Fix Columns Manually to pick one.
              </div>
            )}

            {hasDateErrors && (
              <div className="rounded-lg bg-red-50 p-3 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-400">
                {rowErrors.filter((e) => e.reason === "invalid_date").length} row(s) have a date that couldn&apos;t be read (expected
                YYYY-MM-DD or M/D/YYYY). Fix the file and re-upload - import is blocked until every date parses.
              </div>
            )}

            {hasValueErrors && (
              <div className="rounded-lg bg-red-50 p-3 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-400">
                <p className="mb-1 font-medium">
                  {isSnapshot ? "Non-numeric / missing values found:" : "Non-numeric values found - not imported automatically:"}
                </p>
                <ul className="list-inside list-disc space-y-0.5">
                  {rowErrors
                    .filter((e) => e.reason === "invalid_value")
                    .slice(0, 8)
                    .map((e, i) => (
                      <li key={i}>
                        Row {e.rowIndex + 2}, column &ldquo;{e.column}&rdquo;: &ldquo;{e.raw}&rdquo;
                      </li>
                    ))}
                </ul>
                <p className="mt-1">Uncheck this column above, or fix the values and re-upload.</p>
              </div>
            )}

            {duplicateCount > 0 && (
              <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-400">
                <p className="mb-1 font-medium">
                  {duplicateCount} duplicate {isSnapshot ? "team" : hasTeamColumn ? "date+team" : "date"} combination
                  {duplicateCount === 1 ? "" : "s"} found - the same key appears more than once, and won&apos;t be double-counted
                  automatically.
                </p>
                <ul className="mb-2 list-inside list-disc space-y-0.5">
                  {isSnapshot
                    ? snapshotDuplicates.slice(0, 5).map((d, i) => (
                        <li key={i}>
                          {d.team} - {d.rows.length} rows
                        </li>
                      ))
                    : dailyDuplicates.slice(0, 5).map((d, i) => (
                        <li key={i}>
                          {d.date}
                          {d.team ? ` · ${d.team}` : ""} - {d.rows.length} rows
                        </li>
                      ))}
                </ul>
                <div className="flex items-center gap-2">
                  <span>Keep:</span>
                  <button
                    onClick={() => setDuplicateStrategy("first")}
                    className={"rounded-full px-2.5 py-1 " + (duplicateStrategy === "first" ? "bg-amber-600 text-white" : "bg-card")}
                  >
                    First occurrence
                  </button>
                  <button
                    onClick={() => setDuplicateStrategy("last")}
                    className={"rounded-full px-2.5 py-1 " + (duplicateStrategy === "last" ? "bg-amber-600 text-white" : "bg-card")}
                  >
                    Last occurrence
                  </button>
                </div>
              </div>
            )}

            {importError && <p className="text-xs text-red-500 dark:text-red-400">{importError}</p>}

            <div className="flex justify-end gap-2">
              <button onClick={reset} className="rounded-full bg-muted px-4 py-1.5 text-sm text-muted-foreground hover:text-foreground">
                Start over
              </button>
              <button
                onClick={handleImport}
                disabled={!canImport}
                className="rounded-full bg-brand-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSnapshot ? "Import Snapshot" : "Import"}
              </button>
            </div>
          </div>
        )}

        {step === "importing" && (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">Importing…</div>
        )}

        {step === "done" && importSummary && (
          <div className="space-y-3">
            <p className="text-sm text-foreground">Imported successfully:</p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {importSummary.map((s) => (
                <li key={s.name}>
                  <span className="font-medium text-foreground">{s.name}</span> - {s.pointCount} data point{s.pointCount === 1 ? "" : "s"}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              {isSnapshot
                ? "This appears under “Season snapshots” in the variable library — plot it in Team Comparison to see the per-team bars."
                : "These now appear in the variable library alongside built-in variables, marked with a “Custom” badge."}
            </p>
            <div className="flex justify-end">
              <button onClick={onClose} className="rounded-full bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700">
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
