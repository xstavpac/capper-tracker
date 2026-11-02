// The JSON stored in IngestReviewItem.options. Each choice carries the pick it would create, already matched to a
// game and priced at ingest time, so answering a review item inserts it directly and never matches a game again.
import type { DedupPickRow } from "@/server/data/pick-dedup";

// DedupPickRow with its two Date fields as ISO strings (JSON-safe). overrideDuplicate is never stored: a review
// answer goes through the normal duplicate check.
export type StoredPick = Omit<DedupPickRow, "gameTime" | "oddsCapturedAt" | "overrideDuplicate"> & {
  gameTime: string;
  oddsCapturedAt?: string | null;
};

export type ReviewChoice = {
  // Stable id the answer refers to: "opt:<n>" for an ambiguous team / player, "confirm" for a total line,
  // "use-suggestion" | "new-capper" for a capper near-miss.
  id: string;
  // What the form shows on the button.
  label: string;
  // AmbiguousOption fields, for the team / player questions.
  sport?: string;
  nickname?: string;
  // MISSING_TOTAL_LINE: the market line proposed, and why the pick had none.
  inferredLine?: number;
  lineReason?: "missing" | "garbled";
  // CAPPER_FUZZY: the capper name this choice files the pick under.
  capperName?: string;
  // The pick this choice creates. null when no game could be matched for it (then the choice cannot be taken).
  pick: StoredPick | null;
  // Why `pick` is null.
  unmatched?: string;
};

export type ReviewOptions = { choices: ReviewChoice[] };

export function pickRowToStored(row: DedupPickRow): StoredPick {
  const { gameTime, oddsCapturedAt, overrideDuplicate: _override, ...rest } = row;
  return { ...rest, gameTime: gameTime.toISOString(), oddsCapturedAt: oddsCapturedAt ? oddsCapturedAt.toISOString() : null };
}

export function storedToPickRow(stored: StoredPick, capperName?: string): DedupPickRow {
  const { gameTime, oddsCapturedAt, ...rest } = stored;
  return {
    ...rest,
    capperName: capperName ?? stored.capperName,
    gameTime: new Date(gameTime),
    oddsCapturedAt: oddsCapturedAt ? new Date(oddsCapturedAt) : null,
    overrideDuplicate: false,
  };
}

export function isReviewOptions(value: unknown): value is ReviewOptions {
  if (!value || typeof value !== "object") return false;
  const choices = (value as { choices?: unknown }).choices;
  return Array.isArray(choices) && choices.every((c) => c && typeof c === "object" && typeof (c as ReviewChoice).id === "string");
}
