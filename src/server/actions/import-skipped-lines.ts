"use server";

import { requireUser } from "@/server/auth";
import { recordImportSkippedLines, parseSkippedLineEntries, type ParseSkippedLinesPayload } from "@/server/data/import-skipped-lines";

// Parse-time half of the skipped-line log. The client calls this once after
// handleParse, fire-and-forget. userId comes from the session, never the
// payload. (Payload shape and stage mapping live in the data module because
// a "use server" file may only export async functions.)
export async function logParseSkippedLinesAction(payload: ParseSkippedLinesPayload): Promise<void> {
  try {
    const user = await requireUser();
    await recordImportSkippedLines(user.id, parseSkippedLineEntries(payload));
  } catch {
    // Logging must never surface as an import error.
  }
}
