import { prisma } from "@/lib/prisma";
import { computeMarketHint } from "@/lib/market-hint";
import type { ImportSkipStage } from "@prisma/client";

// Write side of the import skipped-line log (ImportSkippedLine). Nothing in
// the import flow ever reads these rows back; the admin report does.
export type SkippedLineEntry = {
  stage: ImportSkipStage;
  capperName: string;
  rawText: string;
  guessedSport?: string | null;
  reason?: string | null;
};

// Bounds so a hostile or pathological paste can't bloat the table.
const MAX_ENTRIES_PER_WRITE = 500;
const MAX_TEXT_LENGTH = 500;
const MAX_REASON_LENGTH = 300;

const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);

// Every entry's marketHint is derived here, at write time, from the raw line.
export function toSkippedLineRows(userId: string, entries: SkippedLineEntry[]) {
  return entries
    .filter((e) => e.rawText.trim().length > 0)
    .slice(0, MAX_ENTRIES_PER_WRITE)
    .map((e) => ({
      userId,
      capperName: clip(e.capperName || "Unknown", MAX_TEXT_LENGTH),
      rawText: clip(e.rawText, MAX_TEXT_LENGTH),
      guessedSport: e.guessedSport ? clip(e.guessedSport, MAX_TEXT_LENGTH) : null,
      stage: e.stage,
      reason: e.reason ? clip(e.reason, MAX_REASON_LENGTH) : null,
      marketHint: computeMarketHint(e.rawText),
    }));
}

// One batched createMany per call. Logging must never fail or slow an
// import, so every error is swallowed here - callers can await it freely.
export async function recordImportSkippedLines(userId: string, entries: SkippedLineEntry[]): Promise<void> {
  try {
    const data = toSkippedLineRows(userId, entries);
    if (data.length === 0) return;
    await prisma.importSkippedLine.createMany({ data });
  } catch (err) {
    console.error("[import-skipped-lines] failed to record skipped lines", err);
  }
}

// Payload for the parse-time log: everything parseCatalog / the recovery pass
// failed to turn into a pick. The client only supplies text; the stage is
// decided in parseSkippedLineEntries.
export type ParseSkippedLinesPayload = {
  // parseCatalog's droppedAsHeaders + droppedInline: consumed silently.
  silent: { text: string; capperName: string; reason: string }[];
  // The lines left in the manual "couldn't be identified" list.
  unresolved: { text: string; capperName: string }[];
  // False when the recovery pass threw, so these never got a second chance.
  recoveryRan: boolean;
};

const MAX_LINES = 500;

export function parseSkippedLineEntries(payload: ParseSkippedLinesPayload): SkippedLineEntry[] {
  return [
    ...payload.silent.slice(0, MAX_LINES).map((l) => ({
      stage: "PARSE_SILENT" as const,
      capperName: l.capperName,
      rawText: l.text,
      reason: l.reason,
    })),
    ...payload.unresolved.slice(0, MAX_LINES).map((l) => ({
      stage: payload.recoveryRan ? ("RECOVERY_UNRESOLVED" as const) : ("PARSE_UNRESOLVED" as const),
      capperName: l.capperName,
      rawText: l.text,
      reason: payload.recoveryRan
        ? "Still unresolved after the live-schedule / roster recovery pass"
        : "parseCatalog left it unresolved; the recovery pass failed",
    })),
  ];
}

