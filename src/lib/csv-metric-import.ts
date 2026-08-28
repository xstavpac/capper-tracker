// Pure CSV-import logic for Charts' Custom Metrics feature - column
// auto-detection, date/value parsing and validation, duplicate-key
// detection. No prisma import (matches lib/model-builder.ts's own
// client-safety convention - this runs in the browser immediately after a
// file is dropped/picked, well before anything is sent to the server, so
// the confirmation screen's preview/validation feedback is instant, not a
// round trip).
import Papa from "papaparse";

export type ParsedCsv = {
  headers: string[];
  rows: Record<string, string>[];
};

// Parses raw CSV text (already read from the File via file.text()) with
// papaparse - header: true gives each row as a { header: cell } object
// instead of raw arrays, and papaparse's own quoted-field/embedded-comma-or-
// newline/CRLF-vs-LF/BOM handling is exactly why this isn't hand-rolled.
// skipEmptyLines drops a trailing blank line (a common artifact of Excel/
// Sheets exports) rather than surfacing it as a bogus all-empty row.
export function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  const headers = result.meta.fields ?? [];
  return { headers, rows: result.data };
}

const DATE_HEADER_PATTERNS = [/^date$/i, /^game[_ ]?date$/i, /^event[_ ]?date$/i];
const TEAM_HEADER_PATTERNS = [/^team$/i, /^team[_ ]?name$/i, /^school$/i, /^club$/i];

export function detectDateColumn(headers: string[]): string | null {
  return headers.find((h) => DATE_HEADER_PATTERNS.some((p) => p.test(h.trim()))) ?? null;
}

export function detectTeamColumn(headers: string[]): string | null {
  return headers.find((h) => TEAM_HEADER_PATTERNS.some((p) => p.test(h.trim()))) ?? null;
}

// A column "looks numeric" if every non-blank cell in it parses as a plain
// number - used only to auto-suggest value column(s) when there's ambiguity
// (multiple remaining candidates); the actual per-row validation used at
// import time (parseNumericValue below) is what determines pass/fail, this
// is just a heuristic for what to default-select.
function looksNumeric(rows: Record<string, string>[], column: string): boolean {
  let sawAny = false;
  for (const row of rows) {
    const raw = (row[column] ?? "").trim();
    if (raw === "") continue;
    sawAny = true;
    if (!/^-?\d+(\.\d+)?$/.test(raw)) return false;
  }
  return sawAny;
}

// Every header that isn't the detected date/team column and looks numeric
// across the sample - these are the auto-detection's value-column
// candidates. Exactly one -> auto-select it (Step 2's "if exactly one
// remaining numeric column, use it automatically" rule). More than one ->
// the confirmation screen asks the user which to import, pre-checking none
// by default so an accidental import of every numeric column can't happen.
export function detectValueCandidates(parsed: ParsedCsv, dateColumn: string | null, teamColumn: string | null): string[] {
  return parsed.headers.filter((h) => h !== dateColumn && h !== teamColumn && looksNumeric(parsed.rows, h));
}

// "YYYY-MM-DD" if already in that shape, or converted from common
// spreadsheet-export shapes (M/D/YYYY, MM/DD/YYYY) - not a general date
// parser. Returns null (never a guess) for anything else, including
// ambiguous or malformed strings - the importer treats an unparseable date
// as a validation error, same "don't silently coerce" principle as value
// parsing below.
export function parseDateCell(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const month = slash[1].padStart(2, "0");
    const day = slash[2].padStart(2, "0");
    const year = slash[3];
    // Reject an obviously-invalid calendar date (e.g. 13/40/2026) rather
    // than store garbage - Date's own UTC parse is only used to VALIDATE
    // the components here, the actual stored string is still built from
    // the original digits so no timezone shift can occur.
    const asDate = new Date(`${year}-${month}-${day}T00:00:00Z`);
    if (Number.isNaN(asDate.getTime()) || asDate.getUTCDate() !== Number(slash[2])) return null;
    return `${year}-${month}-${day}`;
  }

  return null;
}

// Never coerces - "" (blank) means "no value logged for this date", which
// is a normal gap (same as a built-in snapshot missing a day), not an
// error. Anything present but non-numeric is a real validation failure the
// importer must surface, never silently treated as a gap.
export type ValueParseResult = { kind: "blank" } | { kind: "number"; value: number } | { kind: "invalid" };

export function parseNumericValue(raw: string): ValueParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "blank" };
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return { kind: "invalid" };
  return { kind: "number", value: Number(trimmed) };
}

export type ColumnMapping = {
  dateColumn: string;
  teamColumn: string | null;
  valueColumns: string[];
};

export type RowError = { rowIndex: number; column: string; raw: string; reason: "invalid_date" | "invalid_value" };

export type ImportRow = { rowIndex: number; date: string; team: string | null; values: Record<string, number | null> };

export type BuildRowsResult = { rows: ImportRow[]; errors: RowError[] };

// Turns raw parsed CSV rows into typed import rows using the confirmed
// column mapping, collecting every validation failure instead of stopping
// at the first one - the confirmation screen needs the FULL list of bad
// cells to report, not just "row 4 is broken".
export function buildImportRows(parsed: ParsedCsv, mapping: ColumnMapping): BuildRowsResult {
  const rows: ImportRow[] = [];
  const errors: RowError[] = [];

  parsed.rows.forEach((raw, rowIndex) => {
    const dateRaw = raw[mapping.dateColumn] ?? "";
    const date = parseDateCell(dateRaw);
    if (date === null) {
      errors.push({ rowIndex, column: mapping.dateColumn, raw: dateRaw, reason: "invalid_date" });
      return;
    }

    const team = mapping.teamColumn ? (raw[mapping.teamColumn] ?? "").trim() || null : null;

    const values: Record<string, number | null> = {};
    let rowHasValueError = false;
    for (const col of mapping.valueColumns) {
      const parsedValue = parseNumericValue(raw[col] ?? "");
      if (parsedValue.kind === "invalid") {
        errors.push({ rowIndex, column: col, raw: raw[col] ?? "", reason: "invalid_value" });
        rowHasValueError = true;
      } else {
        values[col] = parsedValue.kind === "number" ? parsedValue.value : null;
      }
    }
    if (rowHasValueError) return;

    rows.push({ rowIndex, date, team, values });
  });

  return { rows, errors };
}

export type DuplicateGroup = { date: string; team: string | null; rows: ImportRow[] };

// Groups rows sharing the same (date, team) key - "team" collapses to a
// fixed sentinel when the metric has no team column at all, so every row
// is treated as potentially colliding with every other row on that date
// (matching CustomMetricPoint's own null-teamName-means-global shape).
// Only groups with more than one row are duplicates; a unique key is never
// included even though it technically "grouped" to itself.
export function findDuplicateKeys(rows: ImportRow[]): DuplicateGroup[] {
  const groups = new Map<string, ImportRow[]>();
  for (const row of rows) {
    const key = row.date + "|" + (row.team ?? "");
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.entries()]
    .filter(([, groupRows]) => groupRows.length > 1)
    .map(([key, groupRows]) => {
      const [date, team] = key.split("|");
      return { date, team: team === "" ? null : team, rows: groupRows };
    });
}

// Applies a duplicate-resolution strategy the user picked - "first" keeps
// each key's earliest row in file order, "last" keeps the latest, and every
// other row sharing that key is dropped. Rows with a unique key are always
// kept untouched. Never called silently - the caller only reaches this
// after the user has seen the duplicate report and explicitly chosen a side.
export function resolveDuplicates(rows: ImportRow[], strategy: "first" | "last"): ImportRow[] {
  const seen = new Map<string, ImportRow>();
  for (const row of rows) {
    const key = row.date + "|" + (row.team ?? "");
    const existing = seen.get(key);
    if (!existing || strategy === "last") seen.set(key, row);
  }
  // Preserve original row order for a stable, unsurprising preview -
  // Map iteration order would otherwise reflect insertion (first-seen) order
  // regardless of which duplicate "won".
  const winners = new Set(seen.values());
  return rows.filter((r) => winners.has(r));
}
