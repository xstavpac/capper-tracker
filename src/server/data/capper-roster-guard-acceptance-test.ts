// Static guard for the cached capper roster (capper-roster.ts): every runtime path that
// creates, renames, favorites, merges or deletes a capper must bust the roster's tag
// (revalidateCapperRoster) after the write. A path that does not leaves every roster read -
// /picks, /charts, /picks/import, the /live category panel, the board's capper names - stale
// until the one-hour backstop.
//
// How: the capper writers are a closed set of functions (WRITERS). A source file may CALL one
// only if it is listed in ACTION_CALLERS (and then each calling function must contain the
// invalidation) or in DEFINERS (the data layer that implements or forwards them). A new caller
// fails this test until someone registers it and busts the tag - which is the point.
//
// Direct writes (prisma.capper.update / updateMany / delete / deleteMany, raw INSERT INTO /
// UPDATE / DELETE FROM cappers) are held to the same rule: only cappers.ts and
// capper-find-or-create.ts may contain one (capper-create-guard-acceptance-test.ts covers
// creation on its own).
//
// Limits: a text scan, a tripwire for the ordinary ways of writing the code (it does not see
// a write assembled from string pieces, or prisma["capper"]). Pure (no database). Run with:
//   npx tsx src/server/data/capper-roster-guard-acceptance-test.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = process.cwd();

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

// Functions whose call can create / rename / favorite / merge / delete a capper.
const WRITERS = [
  "createCapper",
  "findOrCreateCapper",
  "resolveOrCreateCapperId",
  "resolveImportRefs",
  "insertPicksDeduped",
  "mergeCappers",
  "renameCapper",
  "deleteCapper",
  "toggleFavoriteCapper",
];

// The data layer: defines or forwards the writers, never the place to bust a Next cache tag.
const DEFINERS = new Set([
  "src/server/data/cappers.ts",
  "src/server/data/capper-find-or-create.ts",
  "src/server/data/import-refs.ts",
  "src/server/data/pick-dedup.ts",
]);

// createPick (the manual form) hands insertPicksDeduped a capperId that already exists, so it
// creates no capper; asserted below.
const NO_CAPPER_CREATION = new Set(["src/server/data/picks.ts"]);

// Files that call a writer on behalf of a user request: each function that does must bust the
// roster. `via` is the helper the function may call instead of revalidateCapperRoster directly.
const ACTION_CALLERS: Record<string, { via?: string }> = {
  "src/server/actions/cappers.ts": { via: "revalidatePickStats" },
  "src/server/actions/bulk-picks.ts": {},
};

const WRITE_PATTERNS: RegExp[] = [
  /\bcapper\.(update|updateMany|delete|deleteMany)\s*\(/g,
  /\b(UPDATE|DELETE\s+FROM)\s+"?cappers"?\b/gi,
];

function stripComments(input: string): string {
  const src = input.replace(/\r\n/g, "\n");
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:\w"'`])\/\/.*$/gm, (_m, pre) => pre);
}

const callsWriter = (src: string, name: string) => new RegExp(`(?<![\\w.])${name}\\s*\\(`).test(src) || new RegExp(`\\.${name}\\s*\\(`).test(src);
const writersCalled = (src: string) => WRITERS.filter((w) => callsWriter(src, w));
const hasDirectWrite = (src: string) => WRITE_PATTERNS.some((re) => ((re.lastIndex = 0), re.test(src)));

// `export async function name(...) { ... }` bodies, cut at the next top-level function.
function functionBodies(src: string): { name: string; body: string }[] {
  const re = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm;
  const starts: { name: string; index: number }[] = [];
  for (let m = re.exec(src); m; m = re.exec(src)) starts.push({ name: m[1], index: m.index });
  return starts.map((s, i) => ({ name: s.name, body: src.slice(s.index, starts[i + 1]?.index ?? src.length) }));
}

// ---- 1. The scanners must detect what they claim to ----
check("writer scan: direct call", writersCalled("await renameCapper(user.id, id, name);").includes("renameCapper"));
check("writer scan: member call", writersCalled("await data.deleteCapper(u, id)").includes("deleteCapper"));
check("writer scan: ignores a longer name", writersCalled("await renameCapperAction(id, name)").length === 0);
check("writer scan: ignores comments after stripping", writersCalled(stripComments("// createCapper(x)\nconst a = 1;")).length === 0);
check("write scan: prisma.capper.update", hasDirectWrite("await prisma.capper.update({ where, data })"));
check("write scan: tx.capper.deleteMany", hasDirectWrite("await tx.capper.deleteMany({ where })"));
check("write scan: raw UPDATE cappers", hasDirectWrite("await prisma.$executeRaw`UPDATE cappers SET name = ${n}`"));
check("write scan: reads are not writes", !hasDirectWrite("await prisma.capper.findMany({}); await prisma.capper.count({})"));
check(
  "function split: finds both bodies",
  functionBodies("export async function a() { x(); }\nexport async function b() { y(); }").map((f) => f.name).join() === "a,b"
);

// ---- 2. The real tree ----
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}
const rel = (f: string) => relative(repoRoot, f).split("\\").join("/");
const files = walk(join(repoRoot, "src")).filter((f) => !/-test\.ts$/.test(rel(f)) && !/-legacy\.ts$/.test(rel(f)));
check(`scanned ${files.length} source files under src/`, files.length > 100);

const unregistered: string[] = [];
const directWriters: string[] = [];
for (const file of files) {
  const r = rel(file);
  const src = stripComments(readFileSync(file, "utf8"));
  if (hasDirectWrite(src) && !["src/server/data/cappers.ts", "src/server/data/capper-find-or-create.ts"].includes(r)) directWriters.push(r);
  const called = writersCalled(src);
  if (called.length === 0 || DEFINERS.has(r) || NO_CAPPER_CREATION.has(r) || r in ACTION_CALLERS) continue;
  unregistered.push(`${r}  calls ${called.join(", ")}`);
}
check("no direct capper write outside cappers.ts / capper-find-or-create.ts", directWriters.length === 0, "\n    " + directWriters.join("\n    "));
check(
  "no unregistered caller of a capper writer (register it in ACTION_CALLERS and bust the roster, or in DEFINERS if it is data layer)",
  unregistered.length === 0,
  "\n    " + unregistered.join("\n    ")
);

for (const [file, { via }] of Object.entries(ACTION_CALLERS)) {
  const src = stripComments(readFileSync(join(repoRoot, file), "utf8"));
  const bodies = functionBodies(src);
  const writing = bodies.filter((b) => writersCalled(b.body).length > 0);
  check(`${file}: has capper-writing functions`, writing.length > 0);
  for (const fn of writing) {
    const busts = fn.body.includes("revalidateCapperRoster(") || (via !== undefined && fn.body.includes(via + "("));
    check(`${file}: ${fn.name} busts the roster after writing`, busts);
  }
  if (via) {
    const helper = bodies.find((b) => b.name === via);
    check(`${file}: ${via} calls revalidateCapperRoster`, !!helper && helper.body.includes("revalidateCapperRoster("));
  }
}

// createPick: the manual form always names an existing capper (capperId is a required input and is
// verified against the user's cappers before the insert), so insertPicksDeduped creates none.
{
  const src = stripComments(readFileSync(join(repoRoot, "src/server/data/picks.ts"), "utf8"));
  const create = functionBodies(src).find((b) => b.name === "createPick");
  check("createPick takes a required capperId", !!create && /capperId: string;/.test(create.body));
  check("createPick verifies the capper belongs to the user", !!create && /capper\.findFirst\(\{ where: \{ id: data\.capperId, userId \} \}\)/.test(create.body));
}

// The roster accessor itself: cached under its own tag, busted by the same tag.
{
  const src = stripComments(readFileSync(join(repoRoot, "src/server/data/capper-roster.ts"), "utf8"));
  check("getCapperRoster is cached by the roster key", /cachedByTag\(cacheKeys\.cappersRoster\(userId\)/.test(src));
  check("revalidateCapperRoster busts that same key", /revalidateTag\(cacheKeys\.cappersRoster\(userId\)\)/.test(src));
}

process.exit(failures ? 1 : 0);
