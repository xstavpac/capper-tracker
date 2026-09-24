"use server";

import { requireUser } from "@/server/auth";
import { getCachedNflRosterFullNames } from "@/server/data/nfl-roster-cache";

// Full names only (no team/position/espnId) - the client-side bulk-import
// parser (bulk-import-form.tsx) needs just enough to feed parseCatalog's
// findAmbiguousNickname player-prop guard (see that function's own comment
// in parse-catalog.ts), never the rest of NflRosterPlayer's columns. Backed
// by getCachedNflRosterFullNames's cachedByTag wrapper (nfl-roster-cache.ts),
// so a burst of bulk-import page loads shares one Data Cache entry instead of
// each one re-querying Postgres.
export async function getNflRosterFullNamesAction(): Promise<string[]> {
  await requireUser();
  return getCachedNflRosterFullNames();
}
