// READ-ONLY check of the Rising Fast chart against REAL data. Writes nothing: the only DB calls are the
// page's own read (getCappersPageData) and findFirst / findMany. Run:
//
//   npx tsx --env-file=.env scripts/verify-rising-fast-readonly.ts --email=you@example.com
//   npx tsx --env-file=.env scripts/verify-rising-fast-readonly.ts --email=you@example.com --risers=5
//
// For the top risers the page returns, it re-derives everything from the RAW pick rows in plain JS (no
// SQL shared with the page): the capper's newest 100 decided (WIN / LOSS) picks, the last 10 results,
// the baseline win rate of the picks before those, and the cumulative "wins above their norm" line. It
// then compares each with what the page returned and checks the line's last point is the displayed +pts.
// Prints the DATABASE_URL host (password never shown) first so the target is obvious.
import { PrismaClient } from "@prisma/client";
import { getCappersPageData } from "@/server/data/cappers-page-aggregates";
import { FORM_LOOKBACK, RISING_RECENT, risingSeries } from "@/lib/cappers-panels";
import { comparePicksChronologicalDesc } from "@/lib/pick-order";

const args = process.argv.slice(2);
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const EMAIL = arg("email");
const RISERS = Number(arg("risers") ?? 2);

const prisma = new PrismaClient();
const wl = (r: boolean[]) => r.map((w) => (w ? "W" : "L")).join(" ");
const r2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  let host = "unset";
  try {
    host = new URL(process.env.DATABASE_URL ?? "").host;
  } catch {}
  console.log("DATABASE_URL host: " + host);
  if (!EMAIL) throw new Error("pass --email=<account email>");
  const user = await prisma.user.findFirst({ where: { email: EMAIL }, select: { id: true } });
  if (!user) throw new Error("no user with that email");

  const page = await getCappersPageData({ userId: user.id, window: "ALL", min: 0, sort: "roi", fav: false, q: "", page: 1 });
  console.log("Rising Fast rows on the page: " + page.rising.map((e) => e.name + " +" + e.pts).join(", ") + "\n");
  if (page.rising.length === 0) console.log("No risers for this account: nothing to verify.");

  let failed = 0;
  for (const e of page.rising.slice(0, RISERS)) {
    const raw = await prisma.pick.findMany({
      where: { userId: user.id, capperId: e.capperId, status: { in: ["WIN", "LOSS"] } },
      select: { id: true, status: true, gameTime: true, createdAt: true },
    });
    const newest = raw.sort(comparePicksChronologicalDesc).slice(0, FORM_LOOKBACK);
    const recent = newest.slice(0, RISING_RECENT).reverse(); // oldest first
    const prior = newest.slice(RISING_RECENT);
    const results = recent.map((p) => p.status === "WIN");
    const baseline = prior.filter((p) => p.status === "WIN").length / prior.length;
    const wins = results.filter(Boolean).length;
    const line = risingSeries(results, baseline);
    const last = line[line.length - 1];

    const ok = {
      results: wl(results) === wl(e.results),
      baseline: Math.abs(baseline - e.baseline) < 1e-6,
      lastPoint: Math.round(last) === e.pts,
    };
    if (!ok.results || !ok.baseline || !ok.lastPoint) failed++;
    console.log(e.name);
    console.log("  last " + RISING_RECENT + " decided, oldest first: " + wl(results) + "   (" + wins + "-" + (results.length - wins) + ")  page: " + (ok.results ? "same" : "DIFFERENT " + wl(e.results)));
    console.log("  baseline: " + prior.filter((p) => p.status === "WIN").length + " wins of the " + prior.length + " picks before those = " + r2(baseline * 100) + "%  page: " + (ok.baseline ? "same" : "DIFFERENT " + e.baseline));
    console.log("  cumulative points: " + line.map(r2).join(", "));
    console.log("  last point " + r2(last) + " -> rounds to " + Math.round(last) + "; page shows +" + e.pts + " pts: " + (ok.lastPoint ? "MATCH" : "MISMATCH") + "\n");
  }
  if (failed > 0) {
    console.log(failed + " riser(s) did not match.");
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
