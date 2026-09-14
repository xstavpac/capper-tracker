// Proof for odds-api-usage.ts: the pure threshold math (creditUsagePct/
// classifyCreditUsage) plus persistOddsApiUsage/getLatestCreditUsageLevel
// against a stubbed prisma.oddsApiUsageLog (no real DB). Covers the three
// escalating thresholds from the reconciled plan (70% warn / 85% alert /
// 95% stop_lower_priority) and the requestsToday/requestsMonth counting.
//
// Listed in PURE_DESPITE_PRISMA_IMPORT in scripts/run-tests.mjs. Run with:
//   npx tsx src/server/data/odds-api-usage-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import {
  creditUsagePct,
  classifyCreditUsage,
  persistOddsApiUsage,
  getLatestCreditUsageLevel,
  CREDIT_WARN_THRESHOLD,
  CREDIT_ALERT_THRESHOLD,
  CREDIT_STOP_LOWER_PRIORITY_THRESHOLD,
} from "@/server/data/odds-api-usage";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const prismaOriginals: Record<string, unknown> = {};
function patch(path: string, fn: unknown) {
  const [model, method] = path.split(".");
  const target = (prisma as unknown as Record<string, Record<string, unknown>>)[model];
  prismaOriginals[path] ??= target[method];
  target[method] = fn;
}
function restorePrisma() {
  for (const path of Object.keys(prismaOriginals)) {
    const [model, method] = path.split(".");
    (prisma as unknown as Record<string, Record<string, unknown>>)[model][method] = prismaOriginals[path];
  }
}

async function main() {
  // =====================================================================
  // 1. Pure threshold math
  // =====================================================================
  expect("creditUsagePct: 14000 used / 6000 remaining = 0.70 (exactly the warn threshold)", creditUsagePct({ used: 14000, remaining: 6000, lastCost: null }), 0.7);
  expect("creditUsagePct: both headers null -> null (unknown, not 0)", creditUsagePct({ used: null, remaining: null, lastCost: null }), null);
  expect("creditUsagePct: used+remaining = 0 -> null (avoid divide-by-zero)", creditUsagePct({ used: 0, remaining: 0, lastCost: null }), null);

  expect("classifyCreditUsage: exactly 70% -> warn", classifyCreditUsage(CREDIT_WARN_THRESHOLD), "warn");
  expect("classifyCreditUsage: just under 70% -> ok", classifyCreditUsage(CREDIT_WARN_THRESHOLD - 0.001), "ok");
  expect("classifyCreditUsage: exactly 85% -> alert", classifyCreditUsage(CREDIT_ALERT_THRESHOLD), "alert");
  expect("classifyCreditUsage: exactly 95% -> stop_lower_priority", classifyCreditUsage(CREDIT_STOP_LOWER_PRIORITY_THRESHOLD), "stop_lower_priority");
  expect("classifyCreditUsage: 99% -> stop_lower_priority", classifyCreditUsage(0.99), "stop_lower_priority");
  expect("classifyCreditUsage: null (unknown) -> ok, never blocks on missing data", classifyCreditUsage(null), "ok");

  // =====================================================================
  // 2. persistOddsApiUsage: requestsToday/requestsMonth counting + level
  // =====================================================================
  let createdRows: any[] = [];
  patch("oddsApiUsageLog.count", async () => 4); // pretend 4 prior rows exist for both windows
  patch("oddsApiUsageLog.create", async ({ data }: { data: any }) => {
    createdRows.push(data);
    return { id: "row1", ...data };
  });

  const r1 = await persistOddsApiUsage({
    sportKey: "americanfootball_nfl",
    marketsRequested: ["player_pass_tds", "player_anytime_td"],
    eventsRequested: 1,
    credits: { used: 15000, remaining: 5000, lastCost: 5 },
  });
  expect("persistOddsApiUsage: pctUsed computed correctly (15000/20000 = 0.75)", r1.pctUsed, 0.75);
  expect("persistOddsApiUsage: 0.75 classifies as warn (>=70%, not yet >=85% alert)", r1.level, "warn");
  expect("persistOddsApiUsage: requestsToday = prior count (4) + 1", createdRows[0].requestsToday, 5);
  expect("persistOddsApiUsage: requestsMonth = prior count (4) + 1", createdRows[0].requestsMonth, 5);
  expect("persistOddsApiUsage: marketsRequested comma-joined", createdRows[0].marketsRequested, "player_pass_tds,player_anytime_td");
  expect("persistOddsApiUsage: creditsUsed/creditsRemaining stored verbatim", { u: createdRows[0].creditsUsed, r: createdRows[0].creditsRemaining }, { u: 15000, r: 5000 });

  createdRows = [];
  const r2 = await persistOddsApiUsage({
    sportKey: "americanfootball_nfl",
    marketsRequested: ["h2h", "spreads", "totals"],
    eventsRequested: 16,
    credits: { used: 19500, remaining: 500, lastCost: 3 },
  });
  expect("persistOddsApiUsage: 19500/20000 = 0.975 -> stop_lower_priority", r2.level, "stop_lower_priority");

  restorePrisma();

  // =====================================================================
  // 3. getLatestCreditUsageLevel: reads the most recent row
  // =====================================================================
  patch("oddsApiUsageLog.findFirst", async () => ({ creditsUsed: 19000, creditsRemaining: 1000 }));
  expect("getLatestCreditUsageLevel: 19000/20000 = 0.95 -> stop_lower_priority", await getLatestCreditUsageLevel(), "stop_lower_priority");

  patch("oddsApiUsageLog.findFirst", async () => ({ creditsUsed: 1000, creditsRemaining: 19000 }));
  expect("getLatestCreditUsageLevel: low usage -> ok", await getLatestCreditUsageLevel(), "ok");

  patch("oddsApiUsageLog.findFirst", async () => null);
  expect("getLatestCreditUsageLevel: no rows yet -> ok (fail open, never blocks on no data)", await getLatestCreditUsageLevel(), "ok");

  restorePrisma();

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
