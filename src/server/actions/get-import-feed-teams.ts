"use server";

import { requireUser } from "@/server/auth";
import { getImportFeedTeams } from "@/server/data/import-feed-teams";
import type { FeedTeam } from "@/lib/feed-teams";

// Feed-derived teams for the client-side bulk-import parser (see
// getImportFeedTeams). Fetched per parse, not once per session like the roster
// names: the feed's team set changes as games enter and leave its window.
export async function getImportFeedTeamsAction(): Promise<FeedTeam[]> {
  await requireUser();
  return getImportFeedTeams();
}
