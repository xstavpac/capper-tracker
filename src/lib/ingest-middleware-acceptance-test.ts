// Guard: the Telegram reader has no session, so middleware must let POST /api/ingest/telegram through to the route
// handler (no 3xx to /sign-in), while a non-public API route with no session is still bounced. No DB needed.
import { NextRequest, NextResponse } from "next/server";

// Stub the Supabase session step as "no signed-in user".
const stubPath = require.resolve("./supabase/middleware");
require.cache[stubPath] = {
  id: stubPath, filename: stubPath, loaded: true, children: [], paths: [],
  exports: { updateSupabaseSession: async (req: NextRequest) => ({ response: NextResponse.next({ request: req }), user: null }) },
} as unknown as NodeJS.Module;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : " " + detail}`);
  if (!ok) failures++;
}

async function main() {
  const { default: middleware, config } = await import("../middleware");

  const ingest = await middleware(new NextRequest("https://example.test/api/ingest/telegram", { method: "POST", headers: { "x-picks-token": "t" } }));
  check("unauthenticated POST /api/ingest/telegram is not redirected", ingest.status < 300 || ingest.status >= 400, `status ${ingest.status}`);
  check("no sign-in redirect location on the ingest route", !ingest.headers.get("location"), String(ingest.headers.get("location")));

  const other = await middleware(new NextRequest("https://example.test/api/something-private", { method: "POST" }));
  check("a non-public API route with no session still redirects", other.status >= 300 && other.status < 400, `status ${other.status}`);

  check("the matcher covers /api so the middleware runs (and lets it through) rather than being skipped",
    config.matcher.some((m) => m === "/(api|trpc)(.*)"));

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
