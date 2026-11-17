// Pick.uniqueKey: the stored copy of uniquePickKey (unique-picks.ts), so SQL can group "the same bet" without
// re-running the TS key per row. This file only ADAPTS a pick row to uniquePickKey's input; the key's logic stays in
// unique-picks.ts and is not duplicated or changed here. Pure and client-safe.
//
// Every write that creates a pick or changes one of UNIQUE_KEY_FIELDS must store the key of the FULL resulting row
// (never of a partial update). The writers are pinned by pick-unique-key-guard-acceptance-test.ts.
import { uniquePickKey } from "@/lib/unique-picks";

// Every Pick column uniquePickKey reads. id and status are in its input type but are not part of the key.
export const UNIQUE_KEY_FIELDS = [
  "homeTeam",
  "awayTeam",
  "gameTime",
  "gameNumber",
  "period",
  "betType",
  "betDetail",
  "pickedSide",
  "category",
  "line",
  "propMarket",
  "playerName",
] as const;
export type UniqueKeyField = (typeof UNIQUE_KEY_FIELDS)[number];

// A pick row as stored, or as about to be inserted (optional fields left out = the column's default).
export type UniqueKeySource = {
  homeTeam: string;
  awayTeam: string;
  gameTime: Date;
  gameNumber?: number | null;
  period?: string | null;
  betType: string;
  betDetail?: string | null;
  pickedSide?: string | null;
  category?: string | null;
  line?: number | null;
  propMarket?: string | null;
  playerName?: string | null;
};

// The key the row will have once stored. An omitted field is read as its column default: period FULL_GAME, the rest
// null - so the key computed before an insert equals the key recomputed later from the stored row.
export function computeUniqueKey(r: UniqueKeySource): string {
  return uniquePickKey({
    id: "",
    status: "",
    homeTeam: r.homeTeam,
    awayTeam: r.awayTeam,
    gameTime: r.gameTime,
    gameNumber: r.gameNumber ?? null,
    period: r.period ?? "FULL_GAME",
    betType: r.betType,
    betDetail: r.betDetail ?? null,
    pickedSide: r.pickedSide ?? null,
    category: r.category ?? null,
    line: r.line ?? null,
    propMarket: r.propMarket ?? null,
    playerName: r.playerName ?? null,
  });
}

// `const T`: an object literal keeps its literal types ("STATED", "FULL_GAME") so the result still fits Prisma's enums.
export function withUniqueKey<const T extends UniqueKeySource>(row: T): T & { uniqueKey: string } {
  return { ...row, uniqueKey: computeUniqueKey(row) };
}

// True when an update's data names a key field (Prisma semantics: an undefined value is "leave unchanged").
export function touchesUniqueKey(patch: Record<string, unknown>): boolean {
  return UNIQUE_KEY_FIELDS.some((f) => patch[f] !== undefined);
}

// The key of the row AFTER `patch` is applied to `existing`: merged first, then keyed - never the partial update alone.
export function mergedUniqueKey(existing: UniqueKeySource, patch: Partial<Record<UniqueKeyField, unknown>>): string {
  const merged: Record<string, unknown> = { ...existing };
  for (const f of UNIQUE_KEY_FIELDS) if (patch[f] !== undefined) merged[f] = patch[f];
  return computeUniqueKey(merged as UniqueKeySource);
}
