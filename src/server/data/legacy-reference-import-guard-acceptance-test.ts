// Static guard: picks-by-capper-legacy.ts, sport-category-panel-legacy.ts, dashboard-summary-legacy.ts and capper-detail-legacy.ts
// are frozen, pre-migration reference implementations - kept ONLY so
// picks-by-capper-aggregates-acceptance-test.ts / capper-list-aggregates-acceptance-test.ts /
// live-category-panel-parity-acceptance-test.ts and the T2 harness
// (scripts/t2-harness/capture-picks-by-capper.ts, capture-output.ts) have
// something to diff the SQL paths against. Nothing under src/ outside a
// *-acceptance-test.ts file may import either module - if production code
// ever depends on one, it's no longer safe to delete once the observation
// period ends, and the whole point of keeping it separate is defeated.
//
// What counts as importing it: any `from "@/server/data/picks-by-capper-legacy"`
// or `from "@/server/data/sport-category-panel-legacy"` (relative-path
// imports of the same files would also be flagged, since the regex matches
// on the file's own name segment, not just the alias).
//
// Pure (no database). Run with:
//   npx tsx src/server/data/legacy-reference-import-guard-acceptance-test.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = process.cwd();

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const GUARDED_MODULES = ["picks-by-capper-legacy", "sport-category-panel-legacy", "dashboard-summary-legacy", "capper-detail-legacy"];

function stripComments(input: string): string {
  const src = input.replace(/\r\n/g, "\n");
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:\w"'`])\/\/.*$/gm, (_m, pre) => pre);
}

function findImports(source: string): string[] {
  const src = stripComments(source);
  const found: string[] = [];
  for (const name of GUARDED_MODULES) {
    // Matches a static or dynamic import naming the module by its final path
    // segment, however it's aliased ("@/server/data/<name>" or a relative path).
    const re = new RegExp(`from\\s*["'][^"']*\\b${name}["']|import\\s*\\(\\s*["'][^"']*\\b${name}["']`, "g");
    if (re.test(src)) found.push(name);
  }
  return found;
}

// ---- 1. The scanner itself ----
for (const name of GUARDED_MODULES) {
  check(`scanner flags: static import of ${name}`, findImports(`import { x } from "@/server/data/${name}";`).includes(name));
  check(`scanner flags: dynamic import of ${name}`, findImports(`const m = await import("@/server/data/${name}");`).includes(name));
  check(`scanner flags: relative import of ${name}`, findImports(`import { x } from "./${name}";`).includes(name));
  check(`scanner ignores: mentioned in a comment`, findImports(`// see @/server/data/${name} for the old path`).length === 0);
}

// ---- 2. The real tree ----
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".snapshots" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}
const rel = (f: string) => relative(repoRoot, f).split("\\").join("/");

// The two legacy files themselves are excluded (they don't import each
// other or themselves in a way that should trip this).
const srcFiles = walk(join(repoRoot, "src")).filter(
  (f) => !/-test\.ts$/.test(f) && !GUARDED_MODULES.some((name) => f.endsWith(`${name}.ts`))
);
check(`scanned ${srcFiles.length} non-test source files under src/`, srcFiles.length > 100);

const offenders: string[] = [];
for (const file of srcFiles) {
  const hits = findImports(readFileSync(file, "utf8"));
  for (const name of hits) offenders.push(`${rel(file)} imports ${name}`);
}
check("no production file under src/ imports a legacy reference module", offenders.length === 0, "\n    " + offenders.join("\n    "));

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
