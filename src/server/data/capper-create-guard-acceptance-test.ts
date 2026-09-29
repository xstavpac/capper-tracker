// Static guard: the ONLY runtime code that may insert a Capper row is
// findOrCreateCapper (src/server/data/capper-find-or-create.ts).
//
// Why: cappers_user_lower_name_key makes a duplicate name a hard error, and
// findOrCreateCapper is what turns that into "return the existing capper" (raw
// INSERT ... ON CONFLICT DO NOTHING, safe inside a transaction). A direct
// prisma.capper.create bypasses both the strict normalizeName pre-check and the
// race handling, and would 500 on a collision instead.
//
// What counts as a creation (comments stripped):
//   - <client>.capper.create / createMany / createManyAndReturn / upsert(
//   - a nested write through a relation:  cappers: { create | createMany | connectOrCreate
//     (or capper: { create | connectOrCreate })
//   - raw SQL:  INSERT INTO cappers
// Allowlisted explicitly: *-test.ts files (fixtures), prisma/seed-dev.ts,
// scripts/t2-harness/measure-capper-detail.ts (synthetic benchmark data) and
// scripts/t2-harness/fixtures.ts (dev/harness seeds, never run in production).
//
// Limits: a text scan - a tripwire for the ordinary ways of writing the code, not
// a proof (misses prisma["capper"] or an INSERT assembled from string pieces).
//
// Pure (no database). Run with:
//   npx tsx src/server/data/capper-create-guard-acceptance-test.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = process.cwd();

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const HELPER = "src/server/data/capper-find-or-create.ts";
const ALLOWLIST = new Set(["prisma/seed-dev.ts", "scripts/t2-harness/fixtures.ts", "scripts/t2-harness/measure-capper-detail.ts"]);

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "capper.create/createMany/createManyAndReturn/upsert", re: /\bcapper\.(create|createMany|createManyAndReturn|upsert)\s*\(/g },
  { name: "nested cappers: { create | createMany | connectOrCreate }", re: /\bcappers?\s*:\s*\{\s*(create|createMany|connectOrCreate)\b/g },
  { name: "raw INSERT INTO cappers", re: /INSERT\s+INTO\s+"?cappers"?/gi },
];

function stripComments(input: string): string {
  const src = input.replace(/\r\n/g, "\n");
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:\w"'`])\/\/.*$/gm, (_m, pre) => pre);
}

function findCapperCreations(source: string): { line: number; name: string; text: string }[] {
  const src = stripComments(source);
  const found: { index: number; line: number; name: string; text: string }[] = [];
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      found.push({ index: m.index, line: src.slice(0, m.index).split("\n").length, name, text: m[0] });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

// ---- 1. The scanner must detect what it claims to ----
const MUST_FLAG: [string, string][] = [
  ["prisma.capper.create", "await prisma.capper.create({ data: {} });"],
  ["tx.capper.createMany", "await tx.capper.createMany({ data: rows });"],
  ["createManyAndReturn", "await db.capper.createManyAndReturn({ data: rows });"],
  ["capper.upsert", "await prisma.capper.upsert({ where, create, update });"],
  ["destructured capper.create", "const { capper } = prisma; await capper.create({ data });"],
  ["nested user -> cappers create", "prisma.user.create({ data: { cappers: { create: [{ name }] } } })"],
  ["nested connectOrCreate", "data: { capper: { connectOrCreate: { where, create } } }"],
  ["raw INSERT INTO cappers", 'await prisma.$executeRaw`INSERT INTO cappers (id) VALUES (${id})`;'],
  ["raw INSERT INTO quoted", "await prisma.$executeRawUnsafe('INSERT INTO \"cappers\" (id) VALUES (1)');"],
];
const MUST_NOT_FLAG: [string, string][] = [
  ["mentioned in a line comment", "// prisma.capper.create is banned here"],
  ["mentioned in a block comment", "/* tx.capper.createMany(...) */ const x = 1;"],
  ["updates/deletes are not creations", "await prisma.capper.update({ where, data });\nawait prisma.capper.deleteMany({});"],
  ["reads", "await prisma.capper.findMany({}); await prisma.capper.count({});"],
  ["other models' creates", "await prisma.pick.create({ data }); await prisma.user.create({ data });"],
];
for (const [label, src] of MUST_FLAG) check(`scanner flags: ${label}`, findCapperCreations(src).length > 0);
for (const [label, src] of MUST_NOT_FLAG) check(`scanner ignores: ${label}`, findCapperCreations(src).length === 0, JSON.stringify(findCapperCreations(src)));

// ---- 2. The real tree ----
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".snapshots" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}
const rel = (f: string) => relative(repoRoot, f).split("\\").join("/");

const files = ["src", "prisma", "scripts"].flatMap((d) => walk(join(repoRoot, d)));
check(`scanned ${files.length} source files under src/, prisma/, scripts/`, files.length > 100);

const offenders: string[] = [];
let helperHits = 0;
for (const file of files) {
  const r = rel(file);
  if (/-test\.ts$/.test(r) || ALLOWLIST.has(r)) continue;
  const hits = findCapperCreations(readFileSync(file, "utf8"));
  if (r === HELPER) {
    helperHits += hits.length;
    continue;
  }
  for (const h of hits) offenders.push(`${r}:${h.line}  ${h.text}  [${h.name}]`);
}
check("no capper creation outside findOrCreateCapper (tests, seed-dev.ts, t2-harness/fixtures.ts excepted)", offenders.length === 0, "\n    " + offenders.join("\n    "));
check("the helper still contains its one INSERT", helperHits === 1, `found ${helperHits}`);
for (const a of ALLOWLIST) {
  try {
    statSync(join(repoRoot, a));
    check(`allowlisted file exists: ${a}`, true);
  } catch {
    check(`allowlisted file exists: ${a}`, false, "stale allowlist entry");
  }
}

process.exit(failures ? 1 : 0);
