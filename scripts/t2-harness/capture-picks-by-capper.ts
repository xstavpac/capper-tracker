// T2 harness: runs ONE named implementation of the picks-by-capper functions
// (getCapperLeagueRecords / getCapperCategoryRecords) against whatever
// DATABASE_URL points at and prints one JSON object (scenario name -> output)
// to stdout - the same shape/contract as capture-output.ts (see its own
// header), just for a different pair of data functions. A separate entry
// point because the request shape here (leagueEntries / categoryPairs) has
// nothing in common with the Cappers-page functions capture-output.ts drives.
//
// Usage:
//   node --import tsx scripts/t2-harness/capture-picks-by-capper.ts --impl=legacy --fixture-user=A
//   node --import tsx scripts/t2-harness/capture-picks-by-capper.ts --impl=sql --user-id=<cuid>
import { ALL_CATEGORY_KEYS, type PickCategoryKey } from "@/server/data/stats";
import { assertNotProd } from "./lib/prod-guard.mjs";
import { FIXTURE_USER_A_SUPABASE_ID, FIXTURE_USER_B_SUPABASE_ID } from "./fixture-user-ids.mjs";

const dbUrl = process.env.DATABASE_URL ?? "";
assertNotProd(dbUrl, "DATABASE_URL (capture-picks-by-capper.ts)");

type LeagueEntry = { capperId: string; leagueSport: string; category: PickCategoryKey | null };
type CategoryPair = { capperId: string; category: PickCategoryKey };
type Impl = {
  getCapperLeagueRecords: (userId: string, entries: LeagueEntry[]) => Promise<unknown>;
  getCapperCategoryRecords: (userId: string, pairs: CategoryPair[]) => Promise<unknown>;
};

// The plug-in registry (README.md's convention): "legacy" is the frozen
// pre-migration raw-pick JS path, "sql" is the new database-side aggregation.
// Loaders, not eager imports, so a broken one never breaks the other.
const IMPLEMENTATIONS: Record<string, () => Promise<Impl>> = {
  legacy: async () => {
    const mod = await import("@/server/data/picks-by-capper-legacy");
    return {
      getCapperLeagueRecords: mod.getCapperLeagueRecordsLegacy,
      getCapperCategoryRecords: mod.getCapperCategoryRecordsLegacy,
    };
  },
  sql: async () => {
    const mod = await import("@/server/data/picks");
    return { getCapperLeagueRecords: mod.getCapperLeagueRecords, getCapperCategoryRecords: mod.getCapperCategoryRecords };
  },
};

function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, ...rest] = a.replace(/^--/, "").split("=");
      return [k, rest.join("=") || true];
    })
  );
  return args as Record<string, string | true>;
}

async function resolveAutoUserId(prisma: typeof import("@/lib/prisma").prisma): Promise<string> {
  const top = await prisma.pick.groupBy({ by: ["userId"], _count: { userId: true }, orderBy: { _count: { userId: "desc" } }, take: 1 });
  if (!top.length) throw new Error("--auto-user: no user with at least one pick found in this DB");
  return top[0].userId;
}

async function resolveUserId(prisma: typeof import("@/lib/prisma").prisma, args: Record<string, string | true>): Promise<string> {
  if (typeof args["user-id"] === "string") return args["user-id"];
  const fixtureUser = args["fixture-user"];
  if (fixtureUser === "A" || fixtureUser === "B") {
    const supabaseId = fixtureUser === "A" ? FIXTURE_USER_A_SUPABASE_ID : FIXTURE_USER_B_SUPABASE_ID;
    const user = await prisma.user.findUnique({ where: { supabaseId } });
    if (!user) throw new Error(`fixture user ${fixtureUser} (${supabaseId}) not found - did fixtures.ts run against this DB?`);
    return user.id;
  }
  if (args["auto-user"] === true) return resolveAutoUserId(prisma);
  throw new Error("must pass --user-id=<cuid>, --fixture-user=A|B, or --auto-user");
}

async function main() {
  const args = parseArgs();
  const implName = args.impl;
  if (typeof implName !== "string" || !IMPLEMENTATIONS[implName]) {
    console.error(`Usage: --impl=<${Object.keys(IMPLEMENTATIONS).join("|")}> --user-id=<cuid>|--fixture-user=A|B`);
    process.exit(1);
  }
  const impl = await IMPLEMENTATIONS[implName]();
  const { prisma } = await import("@/lib/prisma");
  const userId = await resolveUserId(prisma, args);

  const cappers = await prisma.capper.findMany({ where: { userId }, select: { id: true } });
  const capperIds = cappers.map((c) => c.id);
  const sportsPresent = (await prisma.pick.findMany({ where: { userId }, distinct: ["sportId"], select: { sport: { select: { name: true } } } })).map(
    (p) => p.sport.name
  );
  // At least one league to exercise even a fixture with a single sport, plus
  // a lowercase variant of the first one to exercise sport-name case
  // sensitivity (design doc §8 synthetic tests).
  const leagues = Array.from(new Set([...sportsPresent, sportsPresent[0]?.toLowerCase()].filter((s): s is string => !!s)));

  const out: Record<string, unknown> = {};

  // Scenario 1/2 (design doc §8): every capper, over every league it has
  // picks in x every category, plus a null-category entry - all cappers in
  // ONE call (catches cross-capper contamination).
  const allEntries: LeagueEntry[] = [];
  for (const capperId of capperIds) {
    for (const leagueSport of leagues) {
      for (const category of ALL_CATEGORY_KEYS) allEntries.push({ capperId, leagueSport, category });
      allEntries.push({ capperId, leagueSport, category: null });
    }
  }
  out["leagueRecords.allCappersOneCall"] = await impl.getCapperLeagueRecords(userId, allEntries);

  // Scenario 3: every (capper, category) pair, including pairs with no picks.
  const allPairs: CategoryPair[] = capperIds.flatMap((capperId) => ALL_CATEGORY_KEYS.map((category) => ({ capperId, category })));
  out["categoryRecords.everyPair"] = await impl.getCapperCategoryRecords(userId, allPairs);

  // Scenario 4 (replayed slate): each decided pick's own stored category, one
  // entry per pick - what a live board actually sends.
  const picks = await prisma.pick.findMany({ where: { userId, category: { not: null } }, select: { capperId: true, category: true, sport: { select: { name: true } } } });
  const slateEntries: LeagueEntry[] = picks.map((p) => ({ capperId: p.capperId, leagueSport: p.sport.name, category: p.category as PickCategoryKey }));
  out["leagueRecords.replayedSlate"] = await impl.getCapperLeagueRecords(userId, slateEntries);

  // Scenario 5: empty inputs.
  out["leagueRecords.empty"] = await impl.getCapperLeagueRecords(userId, []);
  out["categoryRecords.empty"] = await impl.getCapperCategoryRecords(userId, []);

  await prisma.$disconnect();
  // The ONLY thing printed to stdout - stderr is free for logging.
  process.stdout.write(JSON.stringify(out));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
