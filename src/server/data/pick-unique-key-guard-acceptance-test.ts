// Static guard for Pick.uniqueKey (lib/pick-unique-key.ts): every write that could change a uniquePickKey input
// keeps the stored key in step. A stale key is a wrong Unique number, not an error, so this is the enforcement.
//
//   1. Creation: the one src/ creator (insertPicksInTransaction, pinned by pick-create-stamp-guard) stamps
//      uniqueKey from computeUniqueKey; every script / seed under scripts/ or prisma/ that creates picks calls
//      withUniqueKey or computeUniqueKey.
//   2. Updates: a `pick.update / updateMany / upsert` call, or a raw `UPDATE picks`, whose text names a key field
//      (UNIQUE_KEY_FIELDS) or spreads an opaque object (`...set`) must sit in a file that calls restampUniqueKeys(.
//      Scanned: src/ (non-test), scripts/, prisma/ - .ts / .mjs / .js, like the stamp guard (the .mts db-monitor
//      capture harness creates throwaway local rows and is out of scope).
//
// Limits: a text scan. It can't follow dynamic property access or SQL assembled from string pieces, and a key field
// named only in a `where` also counts (over-flagging, by design: the fix is the same restamp call).
//
// Pure (no database). Run with:
//   npx tsx src/server/data/pick-unique-key-guard-acceptance-test.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { UNIQUE_KEY_FIELDS } from "@/lib/pick-unique-key";

const repoRoot = process.cwd();
let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

function stripComments(input: string): string {
  const src = input.replace(/\r\n/g, "\n");
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:\w"'`])\/\/.*$/gm, (_m, pre) => pre);
}

const KEY_FIELD = new RegExp(`(?:\\b|")(${UNIQUE_KEY_FIELDS.join("|")})(?:\\b|")\\s*[:,}=]`);
const OPAQUE_SPREAD = /\.\.\.\s*[A-Za-z_$][\w$.]*\s*[,})]/;

export type UpdateSite = { line: number; text: string; keyed: boolean };

// Each update call's argument text (balanced parens) and each raw UPDATE picks statement.
export function findPickUpdates(source: string): UpdateSite[] {
  const src = stripComments(source);
  const out: UpdateSite[] = [];
  const lineOf = (i: number) => src.slice(0, i).split("\n").length;
  const call = /\bpick\s*\.\s*(update|updateMany|upsert)\s*\(/g;
  for (let m = call.exec(src); m; m = call.exec(src)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    const text = src.slice(m.index, i);
    out.push({ line: lineOf(m.index), text, keyed: KEY_FIELD.test(text) || OPAQUE_SPREAD.test(text) });
  }
  const raw = /UPDATE\s+"?picks"?\s+SET\b[^`;]*/gi;
  for (let m = raw.exec(src); m; m = raw.exec(src)) {
    const set = m[0].replace(/\bWHERE\b[\s\S]*$/i, "");
    out.push({ line: lineOf(m.index), text: m[0], keyed: KEY_FIELD.test(set) });
  }
  return out;
}

// ---- 1. The scanner itself ----
const keyed = (s: string) => findPickUpdates(s).some((u) => u.keyed);
check("flags: update naming gameTime", keyed("await prisma.pick.update({ where: { id }, data: { gameTime: t } });"));
check("flags: updateMany shorthand category", keyed("await prisma.pick.updateMany({ where: { id: { in: ids } }, data: { category, categoryVersion: 4 } });"));
check("flags: opaque spread", keyed("await prisma.pick.updateMany({ where, data: { ...set, categoryVersion: 4 } });"));
check("flags: multi-line upsert with betDetail", keyed("await tx.pick.upsert({\n  where: { id },\n  update: { betDetail: d },\n  create: c,\n});"));
check("flags: raw UPDATE picks SET \"pickedSide\"", keyed('await prisma.$executeRaw`UPDATE picks SET "pickedSide" = ${s} WHERE id = ${id}`;'));
check("ignores: status-only grade", !keyed("await prisma.pick.updateMany({ where: { id: pick.id, status: \"PENDING\" }, data: { status: outcome, gradedAt: new Date(), gradedViaFuzzyMatch: false } });"));
check("ignores: conditional literal spread of non-key fields", !keyed("await prisma.pick.update({ where: { id }, data: { status, ...(a ? { gradedAt: new Date() } : {}) } });"));
check("ignores: capper merge", !keyed("await tx.pick.updateMany({ where: { userId, capperId: duplicateId }, data: { capperId: primaryId } });"));
check("ignores: raw uniqueKey write", !keyed('await db.$executeRaw`UPDATE picks SET "uniqueKey" = ${key} WHERE id = ${id} AND "uniqueKey" IS DISTINCT FROM ${key}`;'));
check("ignores: gradedAt / headline / underline lookalikes", !keyed("await prisma.pick.update({ where: { id }, data: { gradedAt: x, headline: y, underline: z } });"));
check("ignores: comments", findPickUpdates("// prisma.pick.update({ data: { gameTime } })\nconst x = 1;").length === 0);

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
const EXTS = [".ts", ".tsx", ".mjs", ".js"];
const files = [
  ...walk(join(repoRoot, "src"), EXTS).filter((f) => !/-test\.ts$/.test(f)),
  ...walk(join(repoRoot, "scripts"), EXTS),
  ...walk(join(repoRoot, "prisma"), EXTS),
];
check(`scanned ${files.length} files`, files.length > 100);

const offenders: string[] = [];
const keyedSites: string[] = [];
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const sites = findPickUpdates(source).filter((s) => s.keyed);
  if (sites.length === 0) continue;
  const restamps = /\brestampUniqueKeys\s*\(/.test(stripComments(source));
  for (const s of sites) {
    keyedSites.push(`${rel(file)}:${s.line}`);
    if (!restamps) offenders.push(`${rel(file)}:${s.line}  ${s.text.replace(/\s+/g, " ").slice(0, 120)}`);
  }
}
check("every update that can change a key field is in a file that calls restampUniqueKeys", offenders.length === 0, "\n    " + offenders.join("\n    "));
// The known keyed writers today (so a silently broken scanner that finds nothing fails here).
for (const f of ["src/server/data/backfill-ml-side.ts", "src/server/data/backfill-pick-category.ts"]) {
  check(`known keyed writer is seen: ${f}`, keyedSites.some((s) => s.startsWith(f + ":")), keyedSites.join(", "));
}

// Creation
const subs = stripComments(readFileSync(join(repoRoot, "src/server/data/subscriptions.ts"), "utf8"));
check("insertPicksInTransaction stamps uniqueKey: computeUniqueKey(...)", /uniqueKey:\s*computeUniqueKey\(/.test(subs));
const CREATE = /\bpick\.(create|createMany|createManyAndReturn|upsert)\s*\(/;
const unstamped: string[] = [];
for (const file of files.filter((f) => !rel(f).startsWith("src/"))) {
  const src = stripComments(readFileSync(file, "utf8"));
  if (CREATE.test(src) && !/\b(withUniqueKey|computeUniqueKey)\s*\(/.test(src)) unstamped.push(rel(file));
}
check("every script/seed that creates picks stamps uniqueKey", unstamped.length === 0, unstamped.join(", "));

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
