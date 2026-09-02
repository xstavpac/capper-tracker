// Local-dev-only synthetic data. NOT run by `npm run prisma:seed` (that's
// reference data only - sports/leagues - and is safe against any database).
// This one creates fake USER / CAPPER / PICK / GAME data so a local dev DB
// isn't an empty shell, and must never run against a shared database.
//
//   npm run prisma:seed-dev
//
// Everything here is idempotent (upserts, or delete-by-owner then recreate)
// so re-running just refreshes the fake data.
import { PrismaClient } from "@prisma/client";
import { seedModelEngineFixtures } from "./seed-ci";

const prisma = new PrismaClient();

// Same refusal logic as scripts/guard-not-prod-db.mjs - a dev seed touching
// production is exactly the Aug 18 incident class.
const PROD_MARKERS = ["kbmdydpacvdmbemcwhry", "pooler.supabase.com"];
const dbUrl = process.env.DATABASE_URL ?? "";
if (PROD_MARKERS.some((m) => dbUrl.includes(m))) {
  console.error(`\n  ✗ DATABASE_URL looks like production ("${PROD_MARKERS.find((m) => dbUrl.includes(m))}").`);
  console.error("  seed-dev only runs against a local database. Aborting.\n");
  process.exit(1);
}

// The identity DEV_AUTH_BYPASS logs in as - see src/lib/dev-auth-bypass.ts
// (DEV_BYPASS_SUPABASE_ID / DEV_BYPASS_EMAIL / DEV_BYPASS_NAME).
const DEV_SUPABASE_ID = "dev-local-bypass";
const DEV_EMAIL = "dev-local@bettingview.test";
const DEV_NAME = "Local Dev Test User";

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

async function main() {
  // ---- sports + leagues (the pieces Picks reference) ----
  const sportRecords: Record<string, string> = {};
  const leagueRecords: Record<string, string> = {};
  for (const [sportName, leagueName] of [
    ["NFL", "NFL"],
    ["MLB", "MLB"],
    ["NBA", "NBA"],
  ]) {
    const sport = await prisma.sport.upsert({ where: { name: sportName }, update: {}, create: { name: sportName } });
    sportRecords[sportName] = sport.id;
    const league = await prisma.league.upsert({
      where: { sportId_name: { sportId: sport.id, name: leagueName } },
      update: {},
      create: { sportId: sport.id, name: leagueName },
    });
    leagueRecords[sportName] = league.id;
  }

  // ---- the dev bypass user (+ a PRO subscription so Charts is usable) ----
  const user = await prisma.user.upsert({
    where: { supabaseId: DEV_SUPABASE_ID },
    update: { email: DEV_EMAIL, name: DEV_NAME },
    create: { supabaseId: DEV_SUPABASE_ID, email: DEV_EMAIL, name: DEV_NAME },
  });
  // currentPeriodEnd must be in the future or isEntitledToPaidTier (see
  // lib/entitlements.ts) treats an "active" PRO sub as not-yet-paid and the
  // user falls back to FREE - which would gate the Pro-only Charts page.
  const periodEnd = new Date(Date.now() + 365 * 86_400_000);
  await prisma.subscription.upsert({
    where: { userId: user.id },
    update: { plan: "PRO", status: "active", currentPeriodEnd: periodEnd },
    create: { userId: user.id, plan: "PRO", status: "active", currentPeriodEnd: periodEnd },
  });

  // ---- cappers (owned by the dev user) ----
  // Wipe this user's existing seed cappers first so re-runs don't pile up.
  await prisma.capper.deleteMany({ where: { userId: user.id } });
  const cappers = await Promise.all(
    [
      { name: "Sharp Sam", source: "TWITTER" as const, sportSpecialization: "NFL" },
      { name: "Diamond Dave", source: "DISCORD" as const, sportSpecialization: "MLB" },
      { name: "Parlay Pete", source: "TELEGRAM" as const, sportSpecialization: null },
    ].map((c) => prisma.capper.create({ data: { userId: user.id, isFavorite: c.name === "Sharp Sam", ...c } }))
  );

  // ---- game results (recent, mix of NFL + MLB) - drives /live, grading,
  //      NFL Game Pulse, and the team-tendency recompute ----
  const games = [
    { sportKey: "americanfootball_nfl", externalId: "dev-nfl-1", homeTeam: "Kansas City Chiefs", awayTeam: "Los Angeles Chargers", homeScore: 27, awayScore: 21, gameDate: daysAgo(6) },
    { sportKey: "americanfootball_nfl", externalId: "dev-nfl-2", homeTeam: "Philadelphia Eagles", awayTeam: "Dallas Cowboys", homeScore: 24, awayScore: 20, gameDate: daysAgo(5) },
    { sportKey: "americanfootball_nfl", externalId: "dev-nfl-3", homeTeam: "Buffalo Bills", awayTeam: "Miami Dolphins", homeScore: 31, awayScore: 17, gameDate: daysAgo(2) },
    { sportKey: "baseball_mlb", externalId: "dev-mlb-1", homeTeam: "New York Yankees", awayTeam: "Boston Red Sox", homeScore: 5, awayScore: 3, gameDate: daysAgo(3) },
    { sportKey: "baseball_mlb", externalId: "dev-mlb-2", homeTeam: "Los Angeles Dodgers", awayTeam: "San Francisco Giants", homeScore: 2, awayScore: 6, gameDate: daysAgo(1) },
  ];
  for (const g of games) {
    await prisma.gameResult.upsert({
      where: { sportKey_externalId: { sportKey: g.sportKey, externalId: g.externalId } },
      update: g,
      create: g,
    });
  }

  // ---- picks (some graded, some pending) across the cappers ----
  await prisma.pick.deleteMany({ where: { userId: user.id } });
  const pickSeed = [
    { capper: cappers[0], sport: "NFL", homeTeam: "Kansas City Chiefs", awayTeam: "Los Angeles Chargers", betType: "SPREAD" as const, betDetail: "Chiefs -3.5", odds: -110, line: -3.5, units: 1, status: "WIN" as const, gameTime: daysAgo(6) },
    { capper: cappers[0], sport: "NFL", homeTeam: "Buffalo Bills", awayTeam: "Miami Dolphins", betType: "MONEYLINE" as const, betDetail: "Bills ML", odds: -180, line: null, units: 2, status: "WIN" as const, gameTime: daysAgo(2) },
    { capper: cappers[1], sport: "MLB", homeTeam: "New York Yankees", awayTeam: "Boston Red Sox", betType: "TOTAL" as const, betDetail: "Over 8.5", odds: -105, line: 8.5, units: 1, status: "LOSS" as const, gameTime: daysAgo(3) },
    { capper: cappers[1], sport: "MLB", homeTeam: "Los Angeles Dodgers", awayTeam: "San Francisco Giants", betType: "MONEYLINE" as const, betDetail: "Giants ML", odds: 145, line: null, units: 1, status: "WIN" as const, gameTime: daysAgo(1) },
    { capper: cappers[2], sport: "NBA", homeTeam: "Denver Nuggets", awayTeam: "Golden State Warriors", betType: "SPREAD" as const, betDetail: "Nuggets -5", odds: -110, line: -5, units: 1, status: "PENDING" as const, gameTime: daysAgo(-1) },
  ];
  for (const p of pickSeed) {
    await prisma.pick.create({
      data: {
        userId: user.id,
        capperId: p.capper.id,
        sportId: sportRecords[p.sport],
        leagueId: leagueRecords[p.sport] ?? null,
        homeTeam: p.homeTeam,
        awayTeam: p.awayTeam,
        betType: p.betType,
        betDetail: p.betDetail,
        odds: p.odds,
        line: p.line,
        units: p.units,
        status: p.status,
        gradedAt: p.status === "PENDING" ? null : p.gameTime,
        datePosted: new Date(p.gameTime.getTime() - 3_600_000),
        gameTime: p.gameTime,
      },
    });
  }

  // Fixture rows the DB-backed model-engine acceptance suites query by
  // hardcoded id/team/date - shared with prisma/seed-ci.ts so `npm test`
  // passes those suites locally too, not just in CI.
  await seedModelEngineFixtures(prisma);

  const counts = {
    users: await prisma.user.count(),
    cappers: await prisma.capper.count(),
    gameResults: await prisma.gameResult.count(),
    picks: await prisma.pick.count(),
  };
  console.log("seed-dev complete:", JSON.stringify(counts));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
