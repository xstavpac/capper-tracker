// Settings > Report a bug: the validation rules, the submit flow (rate limit,
// bad files, the text-only fallback before the bucket and key exist, upload
// failure, orphan cleanup), the admin wiring, and the service-role-key
// boundary - SUPABASE_SERVICE_ROLE_KEY is read in one server file, imported only
// by the submit action and the admin actions, and no client file reaches it.
//
// Pure, no DB, no Supabase (the submit flow runs on fakes). Run with:
//   npx tsx src/lib/bug-report-acceptance-test.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_SCREENSHOT_BYTES,
  RATE_LIMIT_MIN_GAP_MS,
  RATE_LIMIT_PER_DAY,
  buildScreenshotPath,
  cleanPagePath,
  cleanUserAgent,
  decideBugReportRate,
  sniffScreenshotType,
  validateDescription,
  validateScreenshot,
} from "@/lib/bug-report";
import { submitBugReport, type BugReportDeps } from "@/server/bug-reports/submit";
import { ADMIN_TABS } from "@/lib/admin-tabs";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}
const root = join(__dirname, "..", "..");
const src = (p: string) => readFileSync(join(root, p), "utf8");

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const EXE = Uint8Array.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);
const big = (head: Uint8Array, size: number) => {
  const b = new Uint8Array(size);
  b.set(head);
  return b;
};

// ---- 1. Screenshot type comes from the bytes, never the filename ----
{
  expect("PNG / JPEG / WebP are accepted by magic bytes", [sniffScreenshotType(PNG)?.ext, sniffScreenshotType(JPG)?.ext, sniffScreenshotType(WEBP)?.ext], ["png", "jpg", "webp"]);
  expect("SVG, an executable and an empty file are rejected", [sniffScreenshotType(SVG), sniffScreenshotType(EXE), sniffScreenshotType(new Uint8Array())], [null, null, null]);
  expect("RIFF that is not WebP (e.g. WAV) is rejected", sniffScreenshotType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45])), null);
  expect("size: at the cap ok, one byte over rejected", [validateScreenshot(big(WEBP, MAX_SCREENSHOT_BYTES)).ok, validateScreenshot(big(WEBP, MAX_SCREENSHOT_BYTES + 1)).ok], [true, false]);
  expect("cap is 500 KB and under the 1 MB server-action body limit", [MAX_SCREENSHOT_BYTES, MAX_SCREENSHOT_BYTES < 1024 * 1024], [512000, true]);
  expect("an empty screenshot is rejected", validateScreenshot(new Uint8Array()).ok, false);
}

// ---- 2. Text fields ----
{
  expect("description is trimmed", validateDescription("  it broke \n"), { ok: true, value: "it broke" });
  expect("blank / non-string description rejected", [validateDescription("   ").ok, validateDescription(undefined).ok, validateDescription(5).ok], [false, false, false]);
  expect("description at the limit ok, over rejected", [validateDescription("x".repeat(MAX_DESCRIPTION_CHARS)).ok, validateDescription("x".repeat(MAX_DESCRIPTION_CHARS + 1)).ok], [true, false]);
  expect("page path: same-origin paths only", [cleanPagePath("/picks?x=1"), cleanPagePath("https://evil.example/x"), cleanPagePath("//evil.example"), cleanPagePath("picks"), cleanPagePath("/a\u0000b")], ["/picks?x=1", null, null, null, null]);
  expect("page path capped at 200 chars", cleanPagePath("/" + "a".repeat(500))?.length, 200);
  expect("user agent: control chars stripped, capped, blank -> null", [cleanUserAgent("Mozilla\n5.0"), cleanUserAgent("u".repeat(900))?.length, cleanUserAgent("  "), cleanUserAgent(null)], ["Mozilla 5.0", 300, null, null]);
}

// ---- 3. Storage path is server-built; the client filename never reaches it ----
{
  expect("path is {userId}/{reportId}.{ext}", buildScreenshotPath("ckuser1", "rep-1", "webp"), "ckuser1/rep-1.webp");
  let threw = 0;
  for (const bad of ["../x", "a/b", "a b", "", "a\\b", "..%2f"]) {
    try {
      buildScreenshotPath(bad, "rep", "png");
    } catch {
      threw++;
    }
  }
  expect("path segments with / .. spaces are refused", threw, 6);
}

// ---- 4. Rate limit: DB-counted, 5/day and a 60 s gap ----
{
  const now = new Date("2026-10-26T20:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  expect("limits as agreed", [RATE_LIMIT_PER_DAY, RATE_LIMIT_MIN_GAP_MS], [5, 60_000]);
  expect("first report ok", decideBugReportRate({ countInWindow: 0, latestAt: null, now }).ok, true);
  expect("a second within 60 s is denied", decideBugReportRate({ countInWindow: 1, latestAt: ago(30_000), now }).ok, false);
  expect("a second after 60 s is ok", decideBugReportRate({ countInWindow: 1, latestAt: ago(61_000), now }).ok, true);
  expect("the 5th is ok, the 6th in 24 h is denied", [decideBugReportRate({ countInWindow: 4, latestAt: ago(3_600_000), now }).ok, decideBugReportRate({ countInWindow: 5, latestAt: ago(3_600_000), now }).ok], [true, false]);
}

// ---- 5. Submit flow on fakes ----
type World = { inserted: Parameters<BugReportDeps["insert"]>[0][]; uploaded: string[]; removed: string[]; count: number; latestAt: Date | null; configured: boolean; uploadFails: boolean; insertFails: boolean };
function world(over: Partial<World> = {}) {
  const w: World = { inserted: [], uploaded: [], removed: [], count: 0, latestAt: null, configured: true, uploadFails: false, insertFails: false, ...over };
  const deps: BugReportDeps = {
    now: () => new Date("2026-10-26T20:00:00Z"),
    newId: () => "rep1",
    recentActivity: async () => ({ count: w.count, latestAt: w.latestAt }),
    storageConfigured: () => w.configured,
    upload: async (path) => {
      if (w.uploadFails) throw new Error("boom");
      w.uploaded.push(path);
    },
    remove: async (path) => void w.removed.push(path),
    insert: async (row) => {
      if (w.insertFails) throw new Error("db down");
      w.inserted.push(row);
    },
  };
  return { w, deps };
}
const input = (over: Record<string, unknown> = {}) => ({ userId: "u1", description: "chart is blank", pagePath: "/picks", userAgent: "UA", screenshot: null as Uint8Array | null, ...over });

async function main() {
  {
    const { w, deps } = world();
    const r = await submitBugReport(deps, input({ screenshot: WEBP }));
    expect("with bucket + key: screenshot saved, path recorded", [r, w.uploaded, w.inserted[0]?.screenshotPath], [{ ok: true, screenshot: "saved" }, ["u1/rep1.webp"], "u1/rep1.webp"]);
  }
  {
    const { w, deps } = world({ configured: false });
    const r = await submitBugReport(deps, input({ screenshot: WEBP }));
    expect("TEXT-ONLY FALLBACK: no bucket/key yet -> report saved, no upload, user told", [r, w.uploaded.length, w.inserted.length, w.inserted[0]?.screenshotPath], [{ ok: true, screenshot: "unavailable" }, 0, 1, null]);
  }
  {
    const { w, deps } = world({ configured: false });
    const r = await submitBugReport(deps, input());
    expect("text-only report with no screenshot and no bucket: plain success", [r, w.inserted.length], [{ ok: true, screenshot: "none" }, 1]);
  }
  {
    const { w, deps } = world({ uploadFails: true });
    const r = await submitBugReport(deps, input({ screenshot: PNG }));
    expect("upload failure -> text report still saved", [r, w.inserted.length, w.inserted[0]?.screenshotPath], [{ ok: true, screenshot: "unavailable" }, 1, null]);
  }
  {
    const { w, deps } = world({ insertFails: true });
    const r = await submitBugReport(deps, input({ screenshot: JPG }));
    expect("insert failure after upload -> object removed, error returned", [r.ok, w.removed], [false, ["u1/rep1.jpg"]]);
  }
  {
    const { w, deps } = world();
    const r = await submitBugReport(deps, input({ screenshot: SVG }));
    expect("SVG upload rejected before anything is stored", [r.ok, w.uploaded.length, w.inserted.length], [false, 0, 0]);
  }
  {
    const { w, deps } = world();
    const r = await submitBugReport(deps, input({ screenshot: big(PNG, MAX_SCREENSHOT_BYTES + 1) }));
    expect("oversize screenshot rejected before anything is stored", [r.ok, w.uploaded.length, w.inserted.length], [false, 0, 0]);
  }
  {
    const { w, deps } = world({ count: 5 });
    const r = await submitBugReport(deps, input({ screenshot: WEBP }));
    expect("6th report in a day: denied, nothing uploaded or inserted", [r.ok, w.uploaded.length, w.inserted.length], [false, 0, 0]);
  }
  {
    const { w, deps } = world();
    const r = await submitBugReport(deps, input({ description: "   ", screenshot: WEBP }));
    expect("blank description rejected, nothing stored", [r.ok, w.uploaded.length, w.inserted.length], [false, 0, 0]);
  }
  {
    const { w, deps } = world();
    await submitBugReport(deps, input({ pagePath: "https://evil.example", screenshot: null }));
    expect("a full URL as page path is dropped, not stored", w.inserted[0]?.pagePath, null);
  }
}

// ---- 6. Wiring: sender identity, gates, admin tab ----
function wiring() {
  const submit = src("src/server/actions/bug-reports.ts");
  expect("submit action: 'use server', requireUser first, userId from the session not the form", [/^"use server";/.test(submit), submit.indexOf("requireUser()") > 0 && submit.indexOf("requireUser()") < submit.indexOf("formData.get"), /userId: user\.id/.test(submit), /formData\.get\("userId"\)/.test(submit)], [true, true, true, false]);

  const admin = src("src/server/actions/bug-reports-admin.ts");
  const actionBodies = admin.split(/export async function /).slice(1);
  expect("admin actions: every one re-checks requireAdminOpsAction before touching data", [actionBodies.length, actionBodies.every((b) => b.indexOf("requireAdminOpsAction()") > 0 && b.indexOf("requireAdminOpsAction()") < b.search(/getBugReportScreenshotPath|removeScreenshot/))], [2, true]);

  const page = src("src/app/(app)/admin/bug-reports/page.tsx");
  expect("admin page: gated with requireAdminOpsPage before the read", page.indexOf("requireAdminOpsPage()") > 0 && page.indexOf("requireAdminOpsPage()") < page.indexOf("listBugReportsForAdmin()"), true);
  expect("admin tab registered, href matches the page folder", ADMIN_TABS.find((t) => t.key === "bug-reports")?.href, "/admin/bug-reports");

  const data = src("src/server/data/bug-reports.ts");
  expect("data: no deleteMany; resolve filters by id and clears the path", [/deleteMany|\.delete\(/.test(data), /update\(\{ where: \{ id \}, data: \{ status: "RESOLVED", screenshotPath: null \}/.test(data)], [false, true]);
  expect("admin list never selects image bytes (path only), bounded", [/select:/.test(data), /take: ADMIN_BUG_REPORT_LIMIT/.test(data)], [true, true]);

  const schema = src("prisma/schema.prisma");
  expect("schema: no image column in the database", /model BugReport \{[^}]*(Bytes|bytea)/.test(schema), false);
  const sql = src("prisma/migrations/20261026140000_add_bug_reports/migration.sql");
  expect("migration is additive only (no DROP / ALTER COLUMN / UPDATE / DELETE FROM)", /\bDROP\b|ALTER COLUMN|(?<!ON )\bUPDATE\b|DELETE FROM|ALTER TABLE "(?!bug_reports)/i.test(sql), false);
  expect("migration enables RLS on bug_reports and creates no policy", [/ALTER TABLE "bug_reports" ENABLE ROW LEVEL SECURITY;/.test(sql), /CREATE POLICY/i.test(sql)], [true, false]);
  expect("migration creates only bug_reports + its enum", [(sql.match(/CREATE TABLE "([a-z_]+)"/g) ?? []).length, /CREATE TABLE "bug_reports"/.test(sql), /CREATE TYPE "BugReportStatus"/.test(sql)], [1, true, true]);
}

// ---- 7. SUPABASE_SERVICE_ROLE_KEY boundary ----
function keyBoundary() {
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  })(join(root, "src"));
  const rel = (p: string) => relative(root, p).replace(/\\/g, "/");
  const text = new Map(files.map((f) => [rel(f), readFileSync(f, "utf8")]));

  const STORAGE = "src/server/bug-reports/storage.ts";
  const mentioning = [...text].filter(([f, t]) => t.includes("SUPABASE_SERVICE_ROLE_KEY") && !f.endsWith("-test.ts")).map(([f]) => f);
  expect("the key's name appears in exactly one source file", mentioning, [STORAGE]);
  expect("never as NEXT_PUBLIC", [...text].some(([f, t]) => !f.endsWith("-test.ts") && t.includes("NEXT_PUBLIC_SUPABASE_SERVICE")), false);

  const importsOf = (f: string): string[] => {
    const t = text.get(f) ?? "";
    const out: string[] = [];
    for (const m of t.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      let base: string | null = null;
      if (spec.startsWith("@/")) base = "src/" + spec.slice(2);
      else if (spec.startsWith(".")) base = rel(join(dirname(join(root, f)), spec));
      if (!base) continue;
      const hit = [base + ".ts", base + ".tsx", base + "/index.ts", base + "/index.tsx", base].find((c) => text.has(c));
      if (hit) out.push(hit);
    }
    return out;
  };

  const importers = [...text.keys()].filter((f) => importsOf(f).includes(STORAGE) && !f.endsWith("-test.ts")).sort();
  expect("storage.ts is imported only by the submit action and the admin actions", importers, ["src/server/actions/bug-reports-admin.ts", "src/server/actions/bug-reports.ts"]);
  expect("storage.ts is server-only", /^import "server-only";/.test(text.get(STORAGE) ?? ""), true);

  // A client file reaches the key if its import graph hits storage.ts without
  // passing through a "use server" file (a server-action boundary).
  const isClient = (f: string) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(text.get(f) ?? "");
  const isServerAction = (f: string) => /^\s*["']use server["']/.test(text.get(f) ?? "");
  const clients = [...text.keys()].filter(isClient);
  const reaching: string[] = [];
  for (const c of clients) {
    const seen = new Set<string>();
    const stack = [c];
    let hit = false;
    while (stack.length && !hit) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      if (f === STORAGE) hit = true;
      else if (f === c || !isServerAction(f)) stack.push(...importsOf(f));
    }
    if (hit) reaching.push(c);
  }
  expect(`no client file (${clients.length} scanned) reaches storage.ts or the key`, reaching, []);
  expect("the bug-report client files are among those scanned", ["src/components/settings/bug-report-card.tsx", "src/components/admin/bug-report-controls.tsx"].every((f) => clients.includes(f)), true);
}

main().then(() => {
  wiring();
  keyBoundary();
  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nBug report checks passed.");
});
