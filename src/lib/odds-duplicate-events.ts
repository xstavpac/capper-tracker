// Detects two Odds API events for the same teams on the same Eastern date - the
// shape of the 2026-10-01 Phillies @ Braves phantom (2b7c78b3... @ 18:00Z next
// to the real 5524c44b... @ 00:11Z, both in the 4am seed). Used only to LOG
// (see odds.ts' seed and backfill paths) so the frequency of this is visible;
// nothing is deduped or dropped at write time. A genuine MLB doubleheader trips
// it too - it can't be told apart from a phantom here (that needs the schedule
// feed, see live-board-dedup.ts) - so treat a hit as "worth a look", not "bug".
import { easternDateKey } from "@/lib/dates";

type EventLike = { id: string; homeTeam: string; awayTeam: string; commenceTime: string };

export type DuplicateEventGroup = {
  homeTeam: string;
  awayTeam: string;
  etDate: string;
  events: { id: string; commenceTime: string }[];
};

export function findSameDayDuplicateEvents(games: EventLike[]): DuplicateEventGroup[] {
  const groups = new Map<string, DuplicateEventGroup>();
  for (const g of games) {
    const etDate = easternDateKey(new Date(g.commenceTime));
    const key = g.homeTeam + "|" + g.awayTeam + "|" + etDate;
    const group = groups.get(key) ?? { homeTeam: g.homeTeam, awayTeam: g.awayTeam, etDate, events: [] };
    group.events.push({ id: g.id, commenceTime: g.commenceTime });
    groups.set(key, group);
  }
  return [...groups.values()].filter((grp) => grp.events.length > 1);
}

// One warn line per group, JSON like the file's other diagnostics. `source` is
// "seed" or "backfill".
export function warnSameDayDuplicateEvents(
  source: "seed" | "backfill",
  sportKey: string,
  fetchDate: string,
  groups: DuplicateEventGroup[]
): void {
  for (const grp of groups) {
    console.warn("[odds-duplicate-events]", JSON.stringify({ source, sportKey, fetchDate, ...grp }));
  }
}
