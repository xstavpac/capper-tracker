// Static guard: every `pick.findMany(` in production code is a reviewed, bounded
// read. Two checks:
//
//   1. ALLOWLIST - each production file's findMany call sites, one entry per call
//      in source order, each naming what bounds it. A new call (or a removed one)
//      fails until someone writes down its bound here. That is the point: the
//      full-history reads that dominated Supabase egress (2026-10, docs/design/
//      picks-by-capper-egress.md and the follow-up board-window work) were each
//      added without anyone stating what kept them small.
//   2. BANNED SHAPES - the three unbounded shapes seen in pg_stat_statements, by
//      their call text, anywhere in production code:
//        A  where { userId, capperId: { in: [...] } } with nothing else bounding it
//        B  where { userId, sport: { name } } with nothing else bounding it
//        C  where { userId } alone (whole history)
//      "Bounding" = a take, a gameTime/datePosted/gradedAt range, a status, or an
//      id list.
//
// Test files, the legacy reference modules (legacy-reference-import-guard-
// acceptance-test.ts keeps those out of production) and scripts/ are not scanned.
//
// Pure (no database). Run with:
//   npx tsx src/server/data/pick-read-guard-acceptance-test.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = process.cwd();

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

// Must match legacy-reference-import-guard-acceptance-test.ts's GUARDED_MODULES.
const LEGACY_MODULES = [
  "picks-by-capper-legacy",
  "sport-category-panel-legacy",
  "dashboard-summary-legacy",
  "capper-detail-legacy",
  "cappers-legacy",
  "pick-aggregates-legacy",
  "pick-aggregates-cappers-adapter-legacy",
  "units-series-parity",
  "board-picks-legacy",
];

// One entry per findMany call, in source order.
const ALLOWLIST: Record<string, string[]> = {
  "src/server/actions/bulk-picks.ts": ["existingPicksWhere: the paste's cappers x sports x its gameTime span +- drift"],
  "src/server/data/backfill-pick-category.ts": ["keyset batches, take: batchSize", "keyset batches, take: batchSize (in a transaction)"],
  "src/server/data/capper-comparison.ts": ["ONE capper's history (userId + capperId), 15 columns - grows with that capper's history; an explicit comparison click"],
  "src/server/data/cappers.ts": ["mergeCappers: the primary capper's picks, select-only", "mergeCappers: the duplicate capper's picks, select-only"],
  "src/server/data/grading.ts": [
    "one user + sport: PENDING within the regrade lookback",
    "one user + sport: fuzzy-graded within the lookback, take REGRADE_MAX_ROWS",
    "one sport: PENDING within the lookback, take maxPicks",
    "one sport: fuzzy-graded within the lookback, take REGRADE_MAX_ROWS",
  ],
  "src/server/data/parlay-slip-picks.ts": ["id IN the slip's pick ids (<= MAX_POOL_REQUEST_PICKS)"],
  "src/server/data/pick-dedup.ts": ["existingPicksWhere, inside the insert transaction"],
  "src/server/data/picks.ts": [
    "status PENDING (the pending-triage list)",
    "the Picks page's Eastern date range",
    "boardPicksInWindow (getPicksForGame / getPicksForGames): one sport, [earliest game - 6h, latest game + 6h]",
  ],
  "src/server/data/sharp-money.ts": ["one Eastern day (no importer - dead)"],
};

function stripComments(input: string): string {
  const src = input.replace(/\r\n/g, "\n");
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:\w"'`])\/\/.*$/gm, (_m, pre) => pre);
}

// The argument text of every `<x>.pick.findMany(` / `tx.pick.findMany(` call.
function findManyCalls(source: string): string[] {
  const src = stripComments(source);
  const calls: string[] = [];
  const re = /\bpick\s*\.\s*findMany\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    calls.push(src.slice(start, i - 1).replace(/\s+/g, " "));
  }
  return calls;
}

const BOUNDED = /\btake\s*:|\bgameTime\s*:|\bdatePosted\s*:|\bgradedAt\s*:|\bstatus\s*:|\bid\s*:\s*\{\s*in\s*:/;
function bannedShape(call: string): "A" | "B" | "C" | null {
  if (/where\s*:\s*\{\s*userId\s*\}/.test(call)) return "C";
  if (BOUNDED.test(call)) return null;
  if (/\bcapperId\s*:\s*\{\s*in\s*:/.test(call)) return "A";
  if (/\bsport\s*:\s*\{\s*name\s*:/.test(call)) return "B";
  return null;
}

// ---- 1. The scanner itself ----
check("scanner: finds a prisma call", findManyCalls(`await prisma.pick.findMany({ where: { userId } });`).length === 1);
check("scanner: finds a tx call", findManyCalls(`await tx.pick.findMany({ where });`).length === 1);
check("scanner: ignores a comment", findManyCalls(`// prisma.pick.findMany({ where: { userId } })`).length === 0);
check("scanner: ignores other models", findManyCalls(`await prisma.capper.findMany({ where: { userId } });`).length === 0);
check("scanner: nested parens stay in one call", findManyCalls(`prisma.pick.findMany({ where: { id: { in: f(a, b) } } })`)[0]?.includes("f(a, b)") === true);
const shape = (s: string) => bannedShape(findManyCalls(s)[0] ?? "");
check("shape C: where { userId } alone", shape(`prisma.pick.findMany({ where: { userId }, orderBy: { gameTime: "desc" } })`) === "C");
check("shape A: capper list, nothing else", shape(`prisma.pick.findMany({ where: { userId, capperId: { in: ids } } })`) === "A");
check("shape B: sport name, nothing else", shape(`prisma.pick.findMany({ where: { userId, sport: { name: s } }, include: { sport: true } })`) === "B");
check("not banned: capper list + a date range", shape(`prisma.pick.findMany({ where: { userId, capperId: { in: ids }, datePosted: { gte: d } } })`) === null);
check("not banned: sport name + status + take", shape(`prisma.pick.findMany({ where: { userId, status: "PENDING", sport: { name: s } }, take: 5 })`) === null);
check("not banned: one capper", shape(`prisma.pick.findMany({ where: { userId, capperId } })`) === null);

// ---- 2. The real tree ----
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}
const rel = (f: string) => relative(repoRoot, f).split("\\").join("/");
const files = walk(join(repoRoot, "src")).filter((f) => !/-test\.ts$/.test(f) && !LEGACY_MODULES.some((name) => f.endsWith(`${name}.ts`)));
check(`scanned ${files.length} production source files under src/`, files.length > 100);

const found: Record<string, string[]> = {};
for (const file of files) {
  const calls = findManyCalls(readFileSync(file, "utf8"));
  if (calls.length > 0) found[rel(file)] = calls;
}

const countDiffs: string[] = [];
for (const file of new Set([...Object.keys(found), ...Object.keys(ALLOWLIST)])) {
  const have = found[file]?.length ?? 0;
  const listed = ALLOWLIST[file]?.length ?? 0;
  if (have !== listed) countDiffs.push(`${file}: ${have} pick.findMany call(s) in source, ${listed} in ALLOWLIST`);
}
check(
  "every production pick.findMany is on the ALLOWLIST with its bound (add/remove entries when you add/remove a read)",
  countDiffs.length === 0,
  "\n    " + countDiffs.join("\n    ")
);

const banned: string[] = [];
for (const [file, calls] of Object.entries(found)) {
  calls.forEach((call, i) => {
    const s = bannedShape(call);
    if (s) banned.push(`${file} call #${i + 1}: shape ${s}: ${call.slice(0, 140)}`);
  });
}
check("no production pick.findMany has an unbounded shape A/B/C", banned.length === 0, "\n    " + banned.join("\n    "));

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
