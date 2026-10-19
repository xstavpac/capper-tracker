// Static guard: every write to odds_snapshots is followed by a cache
// invalidation, so the odds cache's 1-hour TTL (ODDS_CACHE_TTL_SECONDS, odds.ts)
// stays a backstop rather than a freshness window. Fails when:
//   - a write site (prisma.oddsSnapshot.upsert/update/create/delete..., or raw
//     INSERT/UPDATE/DELETE on odds_snapshots) appears in a function that isn't
//     in WRITERS below - a new write path must be registered with its rule;
//   - a "self" writer's body has no revalidateTag(cacheKeys.odds(...));
//   - a caller of getOddsForSportUncached (which holds the shared upsert) can
//     write without invalidating: it must either revalidate itself
//     (seedOddsSnapshot), pass { fetchIfMissing: false } so it can never write
//     (the cached read in getOddsForSport), or be the on-demand seed
//     (oddsSeedDeps) - the one documented exception: it only runs after the
//     cached read rejected with OddsSnapshotMissingError, which is never
//     stored, so nothing cached exists to invalidate (see its comment in odds.ts).
//
// odds-write-path-invalidation-acceptance-test.ts proves the registered paths
// really ATTEMPT the invalidation at runtime; this file proves no path is
// missing from that set. Pure (no database). Run with:
//   npx tsx src/server/data/odds-snapshot-write-guard-acceptance-test.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = process.cwd();
let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

type Rule = "self" | "via-callers";
const WRITERS: Record<string, Rule> = {
  "src/server/data/odds.ts#getOddsForSportUncached": "via-callers",
  "src/server/data/odds.ts#backfillOddsForSport": "self",
  "src/server/data/nfl-prop-odds.ts#seedNflPropOddsForToday": "self",
  "src/server/data/nhl-goal-scorer-odds.ts#seedNhlGoalScorerOddsForToday": "self",
};
// Callers of getOddsForSportUncached, by enclosing top-level declaration.
const UNCACHED_CALLERS: Record<string, "revalidates" | "read-only" | "on-demand-seed"> = {
  getOddsForSport: "read-only",
  oddsSeedDeps: "on-demand-seed",
  seedOddsSnapshot: "revalidates",
};

const INVALIDATES = /revalidateTag\s*\(\s*cacheKeys\.odds\s*\(/;

function stripComments(input: string): string {
  const src = input.replace(/\r\n/g, "\n");
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:\w"'`])\/\/.*$/gm, (_m, pre) => pre);
}

// Top-level declarations (column 0). They don't nest, so each one's text runs
// to the start of the next, and the declaration enclosing a position is the
// nearest one that starts before it.
type Decl = { name: string; start: number; end: number; body: string };
function topLevelDecls(src: string): Decl[] {
  const re = /^(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z0-9_]+)|const\s+([A-Za-z0-9_]+)|type\s+([A-Za-z0-9_]+)|class\s+([A-Za-z0-9_]+))/gm;
  const starts: { name: string; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) starts.push({ name: (m[1] ?? m[2] ?? m[3] ?? m[4])!, start: m.index });
  return starts.map((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].start : src.length;
    return { ...s, end, body: src.slice(s.start, end) };
  });
}
const enclosing = (decls: Decl[], at: number) => decls.find((d) => at >= d.start && at < d.end);

const WRITE_RE = /oddsSnapshot\s*\.\s*(?:upsert|update|updateMany|create|createMany|delete|deleteMany)\s*\(|(?:insert\s+into|update|delete\s+from)\s+"?odds_snapshots"?/gi;
function writeSites(source: string): { at: number; text: string }[] {
  const src = stripComments(source);
  const out: { at: number; text: string }[] = [];
  let m: RegExpExecArray | null;
  WRITE_RE.lastIndex = 0;
  while ((m = WRITE_RE.exec(src))) out.push({ at: m.index, text: m[0] });
  return out;
}

// ---- 1. Scanner self-tests ----
check("scanner: prisma upsert", writeSites(`await prisma.oddsSnapshot.upsert({ where });`).length === 1);
check("scanner: prisma update in a tx", writeSites(`await tx.oddsSnapshot.update({ where });`).length === 1);
check("scanner: raw UPDATE", writeSites("await prisma.$executeRaw`UPDATE odds_snapshots SET data = 1`;").length === 1);
check("scanner: raw INSERT (quoted)", writeSites('await db.$executeRawUnsafe(`INSERT INTO "odds_snapshots" VALUES (1)`);').length === 1);
check("scanner: reads are not writes", writeSites(`await prisma.oddsSnapshot.findUnique({ where }); SELECT data FROM odds_snapshots`).length === 0);
check("scanner: comments are ignored", writeSites(`// prisma.oddsSnapshot.update({})`).length === 0);
const probe = `export async function writer() {\n  await prisma.oddsSnapshot.update({});\n  revalidateTag(cacheKeys.odds(a, b));\n}\nexport async function sneaky() {\n  await prisma.oddsSnapshot.update({});\n}\n`;
const probeDecls = topLevelDecls(probe);
check("scanner: finds the enclosing function", writeSites(probe).map((w) => enclosing(probeDecls, w.at)?.name).join(",") === "writer,sneaky");
check("scanner: tells an invalidating body from one that isn't", INVALIDATES.test(probeDecls[0].body) && !INVALIDATES.test(probeDecls[1].body));

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
const files = walk(join(repoRoot, "src")).filter((f) => !/-test\.ts$/.test(f));
check(`scanned ${files.length} production source files under src/`, files.length > 100);

const found = new Set<string>();
const unregistered: string[] = [];
const missingInvalidation: string[] = [];
for (const file of files) {
  const raw = readFileSync(file, "utf8");
  const sites = writeSites(raw);
  if (sites.length === 0) continue;
  const src = stripComments(raw);
  const decls = topLevelDecls(src);
  for (const site of sites) {
    const decl = enclosing(decls, site.at);
    const key = `${rel(file)}#${decl?.name ?? "(top level)"}`;
    found.add(key);
    const rule = WRITERS[key];
    if (!rule) unregistered.push(`${key}: ${site.text}`);
    else if (rule === "self" && !INVALIDATES.test(decl!.body)) missingInvalidation.push(key);
  }
}
check("every odds_snapshots write site is a registered writer", unregistered.length === 0, "\n    " + unregistered.join("\n    "));
check("every registered writer still exists (no stale entries)", Object.keys(WRITERS).every((k) => found.has(k)), Object.keys(WRITERS).filter((k) => !found.has(k)).join(", "));
check("every 'self' writer calls revalidateTag(cacheKeys.odds(...)) in its own body", missingInvalidation.length === 0, missingInvalidation.join(", "));

// getOddsForSportUncached holds the shared upsert: check each caller.
const oddsSrc = stripComments(readFileSync(join(repoRoot, "src/server/data/odds.ts"), "utf8"));
const oddsDecls = topLevelDecls(oddsSrc);
const callRe = /getOddsForSportUncached\s*\(([^)]*)\)/g;
const callerProblems: string[] = [];
const callersSeen = new Set<string>();
let c: RegExpExecArray | null;
while ((c = callRe.exec(oddsSrc))) {
  const decl = enclosing(oddsDecls, c.index);
  if (!decl || decl.name === "getOddsForSportUncached") continue; // its own declaration
  callersSeen.add(decl.name);
  const kind = UNCACHED_CALLERS[decl.name];
  if (!kind) callerProblems.push(`${decl.name}: unregistered caller of getOddsForSportUncached`);
  else if (kind === "revalidates" && !INVALIDATES.test(decl.body)) callerProblems.push(`${decl.name}: writes via getOddsForSportUncached but has no revalidateTag(cacheKeys.odds(...))`);
  else if (kind === "read-only" && !/fetchIfMissing\s*:\s*false/.test(c[1])) callerProblems.push(`${decl.name}: must pass { fetchIfMissing: false } (a cached read must never write)`);
}
check("every caller of getOddsForSportUncached either invalidates, cannot write, or is the documented on-demand seed", callerProblems.length === 0, "\n    " + callerProblems.join("\n    "));
check("every registered caller still exists", Object.keys(UNCACHED_CALLERS).every((k) => callersSeen.has(k)), Object.keys(UNCACHED_CALLERS).filter((k) => !callersSeen.has(k)).join(", "));

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
