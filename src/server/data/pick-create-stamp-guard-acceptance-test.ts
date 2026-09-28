// Static guard: the ONLY place a Pick row may be created in src/ is the stamped
// path - createPicksWithEntitlementCheck (subscriptions.ts), which stores
// pickCategory() in Pick.category / Pick.categoryVersion inside the same insert.
//
// Why: the SQL that replaces the JS pick-history aggregation reads the STORED
// category. A pick created any other way has categoryVersion = 0 and category NULL,
// and would silently vanish from every category / league record - a wrong number,
// not an error. There is deliberately no runtime detection or JS fallback (see
// docs/design/picks-by-capper-egress.md, Q2/G4); this test is the enforcement, so
// a new unstamped creator fails CI before it ships.
//
// What counts as a creation (anywhere in src/, comments stripped):
//   - <client>.pick.create / createMany / createManyAndReturn / upsert(
//     (prisma.pick..., tx.pick..., or a destructured `pick.`)
//   - a nested write through a relation:  picks: { create | createMany | connectOrCreate
//   - raw SQL:  INSERT INTO picks
// Test files (*-test.ts) are excluded: they build local fixtures and never run in
// production. Outside src/, any script / seed under scripts/ or prisma/ that creates
// picks must at least call pickCategory() (rule 2), so dev seeds and the T2 harness
// fixtures don't produce unstamped rows either.
//
// Limits (be honest): this is a text scan. It can't see a creation built through
// dynamic property access (`prisma["pick"]`), or an INSERT assembled from string
// pieces. It is a tripwire for the ordinary ways of writing the code, not a proof.
//
// Pure (no database). Run with:
//   npx tsx src/server/data/pick-create-stamp-guard-acceptance-test.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = process.cwd();

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "pick.create/createMany/createManyAndReturn/upsert", re: /\bpick\.(create|createMany|createManyAndReturn|upsert)\s*\(/g },
  { name: "nested picks: { create | createMany | connectOrCreate }", re: /\bpicks\s*:\s*\{\s*(create|createMany|connectOrCreate)\b/g },
  { name: "raw INSERT INTO picks", re: /INSERT\s+INTO\s+"?picks"?/gi },
];

// CRLF checkouts (Windows) are normalized first so the multi-line matching below is line-ending agnostic.
function stripComments(input: string): string {
  const src = input.replace(/\r\n/g, "\n");
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:\w"'`])\/\/.*$/gm, (_m, pre) => pre);
}

export type Creation = { index: number; line: number; name: string; text: string };

export function findPickCreations(source: string): Creation[] {
  const src = stripComments(source);
  const found: Creation[] = [];
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      found.push({ index: m.index, line: src.slice(0, m.index).split("\n").length, name, text: m[0] });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

// ---- 1. The scanner itself must detect what it claims to (a guard that can't fail is worthless) ----
const MUST_FLAG: [string, string][] = [
  ["prisma.pick.create", "await prisma.pick.create({ data: {} });"],
  ["tx.pick.createMany", "await tx.pick.createMany({ data: rows });"],
  ["createManyAndReturn", "await db.pick.createManyAndReturn({ data: rows });"],
  ["pick.upsert (create branch)", "await prisma.pick.upsert({ where, create, update });"],
  ["destructured pick.create", "const { pick } = prisma; await pick.create({ data });"],
  ["multi-line call", "await prisma.pick\n  .create\n  ({ data })".replace("pick\n  .create", "pick.create")],
  ["nested capper -> picks create", "prisma.capper.create({ data: { name, picks: { create: [{ odds: 1 }] } } })"],
  ["nested createMany", "prisma.user.update({ where, data: { picks: { createMany: { data: [] } } } })"],
  ["raw INSERT INTO picks", 'await prisma.$executeRaw`INSERT INTO picks (id) VALUES (${id})`;'],
  ["raw INSERT INTO quoted", 'await prisma.$executeRawUnsafe(\'INSERT INTO "picks" (id) VALUES (1)\');'],
];
const MUST_NOT_FLAG: [string, string][] = [
  ["mentioned in a line comment", "// prisma.pick.create is banned here"],
  ["mentioned in a block comment", "/* tx.pick.createMany(...) */ const x = 1;"],
  ["updates are not creations", "await prisma.pick.update({ where, data });\nawait prisma.pick.updateMany({ where, data });"],
  ["createdAt property", "const t = pick.createdAt; const u = pick.created;"],
  ["a type annotation named picks", "function f(picks: { gameTime: Date }[]) {}"],
  ["other models' creates", "await prisma.capper.create({ data }); await prisma.parlayBet.create({ data: { legs: { create: [] } } });"],
  ["reads", "await prisma.pick.findMany({}); await prisma.pick.count({});"],
];
for (const [label, src] of MUST_FLAG) check(`scanner flags: ${label}`, findPickCreations(src).length > 0);
for (const [label, src] of MUST_NOT_FLAG) check(`scanner ignores: ${label}`, findPickCreations(src).length === 0, JSON.stringify(findPickCreations(src)));

// ---- 2. The real tree ----
function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".snapshots" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}
const rel = (f: string) => relative(repoRoot, f).split("\\").join("/");

const STAMPED_FILE = "src/server/data/subscriptions.ts";
const STAMPED_FUNCTION = "export async function createPicksWithEntitlementCheck";

const srcFiles = walk(join(repoRoot, "src"), [".ts", ".tsx", ".mjs", ".js"]).filter((f) => !/-test\.ts$/.test(f));
check(`scanned ${srcFiles.length} non-test source files under src/`, srcFiles.length > 100);

const offenders: string[] = [];
let stampedHits = 0;
for (const file of srcFiles) {
  const source = readFileSync(file, "utf8");
  const hits = findPickCreations(source);
  if (hits.length === 0) continue;
  if (rel(file) !== STAMPED_FILE) {
    for (const h of hits) offenders.push(`${rel(file)}:${h.line}  ${h.text}  [${h.name}]`);
    continue;
  }
  // The stamped file: every creation must sit inside createPicksWithEntitlementCheck and write the stamp.
  const src = stripComments(source);
  const start = src.indexOf(STAMPED_FUNCTION);
  const end = start < 0 ? -1 : src.indexOf("\n}\n", start);
  for (const h of hits) {
    if (start >= 0 && end > start && h.index > start && h.index < end) {
      stampedHits++;
      const stmt = src.slice(h.index, src.indexOf(";", h.index));
      if (!/\.\.\.stamp\b/.test(stmt)) offenders.push(`${rel(file)}:${h.line}  the create in createPicksWithEntitlementCheck does not spread \`...stamp\``);
    } else {
      offenders.push(`${rel(file)}:${h.line}  ${h.text}  [outside createPicksWithEntitlementCheck]`);
    }
  }
}
check(`no pick creation in src/ outside the stamped path`, offenders.length === 0, "\n    " + offenders.join("\n    "));
check("the stamped path still exists: exactly one creation, inside createPicksWithEntitlementCheck, spreading ...stamp", stampedHits === 1, `found ${stampedHits}`);
check(
  "the stamped path computes the stamp with pickCategory() at PICK_CATEGORY_VERSION",
  (() => {
    const s = readFileSync(join(repoRoot, STAMPED_FILE), "utf8");
    return /category:\s*pickCategory\(/.test(s) && /categoryVersion:\s*PICK_CATEGORY_VERSION/.test(s);
  })()
);

// ---- 3. Dev seeds / harness fixtures outside src/ must stamp too ----
const outsideFiles = [...walk(join(repoRoot, "scripts"), [".ts", ".mjs", ".js"]), ...walk(join(repoRoot, "prisma"), [".ts", ".mjs", ".js"])];
const unstampedCreators: string[] = [];
let creatorsSeen = 0;
for (const file of outsideFiles) {
  const source = readFileSync(file, "utf8");
  const hits = findPickCreations(source);
  if (hits.length === 0) continue;
  creatorsSeen++;
  if (!/\bpickCategory\s*\(/.test(stripComments(source)) || !/categoryVersion\s*:\s*PICK_CATEGORY_VERSION/.test(stripComments(source))) {
    unstampedCreators.push(`${rel(file)}  (creates picks without calling pickCategory() / setting categoryVersion)`);
  }
}
check(`every script/seed that creates picks stamps them (${creatorsSeen} creator file(s) under scripts/ and prisma/)`, unstampedCreators.length === 0, "\n    " + unstampedCreators.join("\n    "));

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
