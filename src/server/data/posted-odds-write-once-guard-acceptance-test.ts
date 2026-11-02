// Static guard: the posted-odds capture columns - Pick.postedLine / oddsCapturedAt / oddsBook / oddsNullReason - are
// written in the INSERT and by nothing afterwards.
//
// Why: they are the price and time a pick was posted at. Break-even scoring, ROI and closing line value all read them,
// and a later price written over one would silently turn "the price when posted" into "some later price" with no way
// to see it happened. There is deliberately no runtime check; this test is the enforcement.
//
// Two rules, both over src/ with comments stripped and test files skipped:
//   1. No pick.update / updateMany / upsert call and no raw `UPDATE picks` statement may name any of the four fields.
//   2. Only the files that capture them at insert may mention them at all, so a NEW writer has to be added to ALLOWED
//      here, in review, on purpose.
// Limits (honest): a text scan. It cannot see a field built through dynamic property access or SQL assembled from
// pieces. It is a tripwire for the ordinary ways of writing the code, not a proof.
//
// Pure (no database). Run with:
//   npx tsx src/server/data/posted-odds-write-once-guard-acceptance-test.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = process.cwd();
const FIELDS = ["postedLine", "oddsCapturedAt", "oddsBook", "oddsNullReason"];
const FIELD_RE = new RegExp("\\b(" + FIELDS.join("|") + ")\\b");
// Rule 2 leaves postedLine out: lib/parlay/consensus.ts has its own, unrelated `postedLine` (a capper's line in a
// consensus position). Rule 1 still covers it, because it only looks inside Pick update calls.
const MENTION_RE = /\b(oddsCapturedAt|oddsBook|oddsNullReason)\b/;

// The only files that may mention the fields: the pure decision, the insert's type, the two creators, and the
// import's resolver. Nothing here updates a pick.
const ALLOWED = new Set([
  "src/lib/odds-source.ts",
  "src/server/data/subscriptions.ts",
  "src/server/data/picks.ts",
  "src/server/actions/bulk-picks.ts",
]);

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

function stripComments(input: string): string {
  const src = input.replace(/\r\n/g, "\n");
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:\w"'`])\/\/.*$/gm, (_m, pre) => pre);
}

// The text of a call from its opening paren to the matching close.
function callBody(src: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(openIdx, i + 1);
  }
  return src.slice(openIdx);
}

export type Finding = { line: number; what: string };

export function findPostedOddsUpdates(source: string): Finding[] {
  const src = stripComments(source);
  const out: Finding[] = [];
  const lineOf = (idx: number) => src.slice(0, idx).split("\n").length;
  const call = /\bpick\.(update|updateMany|upsert)\s*\(/g;
  for (let m = call.exec(src); m; m = call.exec(src)) {
    const body = callBody(src, m.index + m[0].length - 1);
    if (FIELD_RE.test(body)) out.push({ line: lineOf(m.index), what: `pick.${m[1]} names a posted-odds field` });
  }
  // Raw: UPDATE picks ... up to the end of the template literal or statement it sits in.
  const raw = /UPDATE\s+"?picks"?[^`;]{0,600}/gi;
  for (let m = raw.exec(src); m; m = raw.exec(src)) {
    if (FIELD_RE.test(m[0])) out.push({ line: lineOf(m.index), what: "raw UPDATE picks names a posted-odds field" });
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      walk(p, acc);
    } else if (/\.(ts|tsx)$/.test(name) && !/-test\.ts$/.test(name)) acc.push(p);
  }
  return acc;
}

// --- the scanner itself catches what it should --------------------------------------------------------------------
check("scanner: pick.update naming a field is caught", findPostedOddsUpdates("await prisma.pick.update({ where: { id }, data: { oddsCapturedAt: new Date() } });").length === 1);
check("scanner: tx.pick.updateMany naming a field is caught", findPostedOddsUpdates("await tx.pick.updateMany({ where: {}, data: { postedLine: 1 } });").length === 1);
check("scanner: upsert is caught", findPostedOddsUpdates("prisma.pick.upsert({ where: { id }, update: { oddsBook: 'x' }, create: {} })").length === 1);
check("scanner: raw UPDATE picks SET is caught", findPostedOddsUpdates('await prisma.$executeRaw`UPDATE picks SET "oddsNullReason" = NULL WHERE id = ${id}`;').length === 1);
check("scanner: an update of other columns is not flagged", findPostedOddsUpdates("await prisma.pick.update({ where: { id }, data: { status } });").length === 0);
check("scanner: a mention in a comment is ignored", findPostedOddsUpdates("// pick.update({ data: { oddsBook: 1 } })\nconst x = 1;").length === 0);

// --- the repo ---------------------------------------------------------------------------------------------------------
const files = walk(join(repoRoot, "src"));
const updaters: string[] = [];
const mentioners: string[] = [];
for (const f of files) {
  const rel = relative(repoRoot, f).replace(/\\/g, "/");
  const text = readFileSync(f, "utf8");
  for (const fnd of findPostedOddsUpdates(text)) updaters.push(`${rel}:${fnd.line} ${fnd.what}`);
  if (MENTION_RE.test(stripComments(text)) && !ALLOWED.has(rel)) mentioners.push(rel);
}
check("no UPDATE path touches a posted-odds field", updaters.length === 0, "\n  " + updaters.join("\n  "));
check("only the capture files mention the fields", mentioners.length === 0, "\n  " + mentioners.join("\n  ") + "\n  (add a new writer to ALLOWED in review, on purpose)");
check("the guard saw the repo", files.length > 100, `only ${files.length} files`);

if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nall passed");
