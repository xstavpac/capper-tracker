// predev guard - runs automatically before `npm run dev` (npm lifecycle).
//
// The failure mode this prevents: DEV_AUTH_BYPASS=true skips real Supabase
// Auth (README "Local dev auth bypass"), but it does NOT change which
// database DATABASE_URL points at. On Aug 18 a checkout had the bypass on
// AND DATABASE_URL still pointing at the production Supabase pooler, so
// every "local dev" query - including an unscoped deleteMany - ran against
// production. See .scratch-env-incident-writeup.md.
//
// This script refuses to start `next dev` when the bypass is on and
// DATABASE_URL matches a known production marker. Any other combination is
// allowed through untouched.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Minimal KEY=VALUE parser - matches Next.js precedence: process.env wins,
// then .env.local, then .env. Enough for this check; not a full dotenv.
function loadEnv() {
  const merged = {};
  for (const file of [".env", ".env.local"]) {
    let text;
    try {
      text = readFileSync(join(ROOT, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let value = m[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      merged[m[1]] = value;
    }
  }
  return { ...merged, ...process.env };
}

// Known production markers. The project ref is definitive; the pooler host
// covers any Supabase pooler (a local-Postgres dev setup should never use
// one). Add refs here if the prod project ever changes.
const PROD_MARKERS = [
  { pattern: "kbmdydpacvdmbemcwhry", why: "production Supabase project ref" },
  { pattern: "pooler.supabase.com", why: "a Supabase connection pooler host" },
];

const env = loadEnv();
const bypass = String(env.DEV_AUTH_BYPASS ?? "").toLowerCase() === "true";
const dbUrl = env.DATABASE_URL ?? "";

if (!bypass) process.exit(0);

const hit = PROD_MARKERS.find((m) => dbUrl.includes(m.pattern));
if (!hit) process.exit(0);

console.error(
  [
    "",
    "  ✗ Refusing to start `next dev`.",
    "",
    `  DEV_AUTH_BYPASS=true is set, and DATABASE_URL contains "${hit.pattern}"`,
    `  (${hit.why}).`,
    "",
    "  With the auth bypass on, every query the app makes runs against",
    "  whatever DATABASE_URL points at - and this one looks like production.",
    "  This is exactly the Aug 18 incident (.scratch-env-incident-writeup.md).",
    "",
    "  Fix: point DATABASE_URL/DIRECT_URL at a local database (see",
    "  .scratch-env-incident-writeup.md, Option A) - or, if you really do",
    "  mean to run against a remote DB, unset DEV_AUTH_BYPASS first.",
    "",
  ].join("\n")
);
process.exit(1);
