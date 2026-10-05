// T2 harness: runs ONE named implementation's Cappers-page data functions
// against whatever DATABASE_URL points at (a disposable run DB, set by the
// caller) and prints one JSON object of scenario name -> semantic output to
// stdout. This is the layer the diff mechanism actually compares - the
// return values of the exported data functions (LeaderboardEntry[],
// FavoriteCappersSummary, etc.) exactly as /cappers's page.tsx would receive
// them, never raw DB rows or an implementation's internal Map/grouping.
//
// The IMPLEMENTATIONS registry is the plug-in point the T2 build task asks
// for: "ready to accept a NEW implementation later ... without requiring
// production access or code changes to plug in T3 once it exists". Today it
// only has "old" (the current src/server/data/cappers.ts). Once T3 exists,
// register it here under e.g. "t3" - nothing else in this file, or in
// run-diff.mjs, needs to change.
//
// --surface=panels switches this from the /cappers data functions to the /dashboard
// capper panels (getCapperPanels): `old` is the frozen raw-pick implementation
// (capper-panels-legacy.ts), `t3` the database-aggregate one in production. Panels
// are captured for EVERY user with picks (--auto-user) or the one selected, as of a
// fixed clock (--as-of=auto [each user's own last activity] | <ISO>): the 14-day activity gate makes the output depend
// on "now", so a snapshot older than two weeks would otherwise diff two empty panels.
//
// Usage:
//   node --import tsx scripts/t2-harness/capture-output.ts --impl=old --fixture-user=A
//   node --import tsx scripts/t2-harness/capture-output.ts --impl=old --user-id=<cuid>
import { SCORECARD_WINDOWS, type ScorecardWindow } from "@/server/data/stats";
import { assertNotProd } from "./lib/prod-guard.mjs";
import { FIXTURE_USER_A_SUPABASE_ID, FIXTURE_USER_B_SUPABASE_ID } from "./fixture-user-ids.mjs";

const dbUrl = process.env.DATABASE_URL ?? "";
assertNotProd(dbUrl, "DATABASE_URL (capture-output.ts)");

type CappersImpl = {
  getPlanStatus: (userId: string) => Promise<unknown>;
  getCapperLeaderboardTable: (userId: string, window: ScorecardWindow, filter?: { sportName?: string }) => Promise<unknown>;
  getFavoriteCappersSummary: (userId: string, window: ScorecardWindow) => Promise<unknown>;
  getMostActiveThisWeek: (userId: string, filter?: { sportName?: string }) => Promise<unknown>;
  getSportCategoryPanelData: (userId: string, sportName: string) => Promise<unknown>;
};

// cappers.ts no longer exports getSportCategoryPanelData (moved to
// sport-category-panel-legacy.ts - it's unused by any page since #128, kept
// only as this harness's and the parity tests' reference). Every loader that
// treats a plain `@/server/data/cappers` import as a full CappersImpl needs
// this composition instead of that bare import.
async function loadRealCappersImpl(): Promise<CappersImpl> {
  const cappers = await import("@/server/data/cappers");
  const { getSportCategoryPanelData } = await import("@/server/data/sport-category-panel-legacy");
  return { ...cappers, getSportCategoryPanelData } as unknown as CappersImpl;
}

// The plug-in registry. Each entry is a loader (not an eager import) so that
// registering a broken/experimental implementation here never breaks
// loading the "old" one.
const IMPLEMENTATIONS: Record<string, () => Promise<CappersImpl>> = {
  old: loadRealCappersImpl,
  t3: async () => {
    const mod = await import("@/server/data/pick-aggregates-cappers-adapter");
    return mod as unknown as CappersImpl;
  },

  // ---- Self-test-only broken variants (T2 build task, item 3a/3b) ----
  // These exist to PROVE the diff mechanism catches the two failure modes
  // the T3 field-equivalence audit already found on paper, by actually
  // constructing a regressed implementation and confirming the diff flags
  // it - see self-test-failure-modes.mjs. They deliberately live here, in a
  // harness-only file, and touch nothing under src/.

  // Reproduces the capper.name gap: getSportCategoryPanelData without
  // `include: { capper: true }}`, so the per-category leaderboard can't read
  // the real name and falls back to a placeholder.
  "broken-capper-name": async () => {
    const real = await loadRealCappersImpl();
    const stats = await import("@/server/data/stats");
    const { prisma } = await import("@/lib/prisma");
    const CATEGORY_LEADERBOARD_MIN_PICKS = 3; // mirrors cappers.ts's private constant
    const CATEGORY_LEADERBOARD_LIMIT = 5;
    return {
      ...real,
      getSportCategoryPanelData: async (userId: string, sportName: string) => {
        const picks = await prisma.pick.findMany({ where: { userId, sport: { name: sportName } } }); // BUG: no include: { capper: true }
        const picksWithSport = picks.map((p) => ({ ...p, sport: { name: sportName } }));
        const breakdown = stats.computeCategoryBreakdown(picksWithSport, stats.chipSetForLeague(sportName));
        const leaderboards: Record<string, unknown[]> = {};
        for (const item of breakdown) {
          const scoped = picksWithSport.filter((p) => stats.pickCategory({ ...p, sportName }) === item.key);
          const byCapper = new Map<string, { name: string; picks: typeof scoped }>();
          for (const pick of scoped) {
            const existing = byCapper.get(pick.capperId);
            if (existing) existing.picks.push(pick);
            // BUG: no pick.capper relation was fetched, so the real name isn't available here.
            else byCapper.set(pick.capperId, { name: "unknown", picks: [pick] });
          }
          leaderboards[item.key] = Array.from(byCapper.entries())
            .map(([capperId, g]) => {
              const s = stats.computeStats(g.picks as never);
              return { capperId, name: g.name, wins: s.wins, losses: s.losses, pushes: s.pushes, winPct: s.winPct };
            })
            .filter((e) => e.wins + e.losses + e.pushes >= CATEGORY_LEADERBOARD_MIN_PICKS)
            .sort((a, b) => b.winPct - a.winPct)
            .slice(0, CATEGORY_LEADERBOARD_LIMIT);
        }
        return { breakdown, leaderboards };
      },
    };
  },

  // Reproduces the zero-pick-capper-disappearance risk flagged in the T3
  // audit: iterates pick-derived capperIds instead of the roster, so a
  // capper with zero picks has no key in the grouping map and silently
  // never appears - even in the ALL window, where the real implementation
  // explicitly keeps them.
  "broken-zero-pick": async () => {
    const real = await loadRealCappersImpl();
    const stats = await import("@/server/data/stats");
    const { prisma } = await import("@/lib/prisma");
    return {
      ...real,
      getCapperLeaderboardTable: async (userId: string, window: ScorecardWindow, filter?: { sportName?: string }) => {
        const cappers = await (real as unknown as { getCappersForUser: (u: string, f?: unknown) => Promise<{ id: string; name: string; colorTag: string | null; isFavorite: boolean }[]> }).getCappersForUser(userId, filter);
        if (cappers.length === 0) return [];
        const allPicks = await prisma.pick.findMany({
          where: { userId, capperId: { in: cappers.map((c) => c.id) }, ...(filter?.sportName ? { sport: { name: filter.sportName } } : {}) },
          include: { sport: true },
        });
        const windowed = stats.filterPicksByGameWindow(allPicks as never, window);
        const byCapper = new Map<string, typeof allPicks>();
        for (const pick of windowed as typeof allPicks) {
          const list = byCapper.get(pick.capperId);
          if (list) list.push(pick);
          else byCapper.set(pick.capperId, [pick]);
        }
        const allByCapper = new Map<string, typeof allPicks>();
        for (const pick of allPicks) {
          const list = allByCapper.get(pick.capperId);
          if (list) list.push(pick);
          else allByCapper.set(pick.capperId, [pick]);
        }
        const capperById = new Map(cappers.map((c) => [c.id, c]));
        // BUG: iterates byCapper.keys() (pick-derived) instead of `cappers`
        // (the roster) - a zero-pick capper has no key here and is silently
        // dropped, regardless of window.
        return Array.from(byCapper.keys()).map((capperId) => {
          const capper = capperById.get(capperId)!;
          const s = stats.computeStats((byCapper.get(capperId) ?? []) as never);
          return {
            capperId,
            name: capper.name,
            colorTag: capper.colorTag,
            stats: s,
            weightedScore: stats.weightedRoiScore(s),
            specialist: stats.computeSpecialistTag((allByCapper.get(capperId) ?? []) as never),
            isFavorite: capper.isFavorite,
          };
        });
      },
    };
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

// --auto-user: for a real (anonymized) snapshot, where no fixture id and no
// hand-picked cuid exist, pick the user with the most picks in THIS
// disposable run DB - deterministic given fixed data, and returns only a
// cuid (never a name/email/other PII column) so nothing beyond an opaque id
// ever leaves this query. Runs inside the same disposable-DB-per-run
// process that already owns this connection; never a separate DB or query
// against anything outside it.
async function resolveAutoUserId(prisma: typeof import("@/lib/prisma").prisma): Promise<string> {
  const top = await prisma.pick.groupBy({
    by: ["userId"],
    _count: { userId: true },
    orderBy: { _count: { userId: "desc" } },
    take: 1,
  });
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

// ---- panels surface ---------------------------------------------------------

type PanelsImpl = { getCapperPanels: (userId: string, filter?: { sportName?: string }) => Promise<unknown> };

const PANELS_IMPLEMENTATIONS: Record<string, () => Promise<PanelsImpl>> = {
  old: async () => {
    const { getCapperPanelsLegacy } = await import("@/server/data/capper-panels-legacy");
    return { getCapperPanels: getCapperPanelsLegacy };
  },
  t3: async () => {
    const { getCapperPanels } = await import("@/server/data/capper-panels");
    return { getCapperPanels };
  },
};

// Every user with at least one pick, most picks first - the snapshot has a handful,
// and a bug that only shows on a small or oddly-shaped account is exactly what a
// top-user-only diff would miss.
async function allUserIdsWithPicks(prisma: typeof import("@/lib/prisma").prisma): Promise<string[]> {
  const rows = await prisma.pick.groupBy({ by: ["userId"], _count: { userId: true }, orderBy: { _count: { userId: "desc" } } });
  return rows.map((r) => r.userId);
}

// Fixes "now" for everything the implementation calls: Date.now() and a bare new Date().
// Applied only after Prisma has loaded, only for the panels surface.
const RealDate = Date;
function freezeClock(iso: string) {
  const fixed = RealDate.parse(iso);
  class FrozenDate extends RealDate {
    constructor(...a: unknown[]) {
      if (a.length === 0) super(fixed);
      else super(...(a as [number]));
    }
    static now() {
      return fixed;
    }
  }
  globalThis.Date = FrozenDate as unknown as DateConstructor;
}

// Normalization of the ONE intended difference: the original streak entries' stats
// carried longestWinStreak / longestLossStreak, which nothing reads and the new
// implementation no longer produces. Dropped from both sides so the diff shows only
// real differences.
function dropLongestStreaks(panels: unknown): unknown {
  const p = JSON.parse(JSON.stringify(panels, (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v))) as {
    hotStreaks?: { stats?: Record<string, unknown> }[];
    coolingOff?: { stats?: Record<string, unknown> }[];
  };
  for (const list of [p.hotStreaks ?? [], p.coolingOff ?? []]) {
    for (const e of list) {
      // Only the legacy implementation's streak rows carry stats.
      delete e.stats?.longestWinStreak;
      delete e.stats?.longestLossStreak;
    }
  }
  return p;
}

async function mainPanels(args: Record<string, string | true>) {
  const implName = args.impl;
  if (typeof implName !== "string" || !PANELS_IMPLEMENTATIONS[implName]) {
    console.error(`Usage: --surface=panels --impl=<${Object.keys(PANELS_IMPLEMENTATIONS).join("|")}> --auto-user|--user-id=<cuid>|--fixture-user=A|B [--as-of=auto|<ISO>]`);
    process.exit(1);
  }
  const impl = await PANELS_IMPLEMENTATIONS[implName]();
  const { prisma } = await import("@/lib/prisma");

  const userIds = args["auto-user"] === true ? await allUserIdsWithPicks(prisma) : [await resolveUserId(prisma, args)];

  // auto = each user as of one hour after THEIR OWN latest datePosted, so every
  // account (not just the most recently active one) has cappers inside the 14-day
  // activity window. Resolved before the clock is frozen.
  const asOf = args["as-of"];
  const asOfByUser = new Map<string, string>();
  if (asOf === "auto") {
    for (const userId of userIds) {
      const latest = await prisma.pick.aggregate({ where: { userId }, _max: { datePosted: true } });
      if (latest._max.datePosted) asOfByUser.set(userId, new RealDate(latest._max.datePosted.getTime() + 3600000).toISOString());
    }
  }

  const out: Record<string, unknown> = {};
  for (const [i, userId] of userIds.entries()) {
    const iso = asOf === "auto" ? asOfByUser.get(userId) : typeof asOf === "string" ? asOf : undefined;
    if (iso) freezeClock(iso);
    for (const sportName of [undefined, "MLB", "NFL"] as const) {
      out[`user${i}.panels.${sportName ?? "allLeagues"}`] = dropLongestStreaks(
        await impl.getCapperPanels(userId, sportName ? { sportName } : undefined)
      );
    }
  }
  await prisma.$disconnect();
  process.stdout.write(JSON.stringify(out));
}

async function main() {
  const args = parseArgs();
  if (args.surface === "panels") return mainPanels(args);
  const implName = args.impl;
  if (typeof implName !== "string" || !IMPLEMENTATIONS[implName]) {
    console.error(`Usage: --impl=<${Object.keys(IMPLEMENTATIONS).join("|")}> --user-id=<cuid>|--fixture-user=A|B`);
    process.exit(1);
  }
  const impl = await IMPLEMENTATIONS[implName]();
  const { prisma } = await import("@/lib/prisma");
  const userId = await resolveUserId(prisma, args);

  const out: Record<string, unknown> = {};

  out["planStatus"] = await impl.getPlanStatus(userId);

  for (const league of [undefined, "MLB", "NFL"] as const) {
    const leagueKey = league ?? "allLeagues";
    for (const window of SCORECARD_WINDOWS) {
      out[`leaderboard.${leagueKey}.${window}`] = await impl.getCapperLeaderboardTable(userId, window, { sportName: league });
    }
    out[`mostActive.${leagueKey}`] = await impl.getMostActiveThisWeek(userId, { sportName: league });
  }

  for (const window of SCORECARD_WINDOWS) {
    out[`favoritesSummary.${window}`] = await impl.getFavoriteCappersSummary(userId, window);
  }

  for (const sportName of ["MLB", "NFL"]) {
    out[`categoryPanel.${sportName}`] = await impl.getSportCategoryPanelData(userId, sportName);
  }

  await prisma.$disconnect();
  // The ONLY thing printed to stdout - stderr is free for logging.
  process.stdout.write(JSON.stringify(out));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
