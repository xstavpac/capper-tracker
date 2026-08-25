// Proof for the auth-callback cookie-write fix - run with:
//   npx tsx src/app/auth/callback/route-acceptance-test.ts
//
// No test framework exists in this repo (see parse-catalog-acceptance-
// test.ts's own header for why); this is the same kind of persisted
// regression script.
//
// What this proves, and what it deliberately does NOT: this is a
// behavioral test of the exact cookie-write pattern each version of the
// code uses, run against a REAL NextResponse instance (not a reimplemented
// stand-in) - it is NOT a live end-to-end test of the real route.ts GET
// handler, since that would require a real Supabase OAuth `code` (live
// credentials, a real network round-trip, no clean way to force a cookie-
// write failure AFTER a genuinely successful exchange without live OAuth).
// The two patterns below are intentionally short and mirror their real
// source exactly (OLD = lib/supabase/server.ts's createSupabaseServerClient
// setAll, NEW = route.ts's own setAll) - if either drifts from what's
// actually shipped, trust the real source files over this file's comments.
import { NextResponse } from "next/server";

type CookieToSet = { name: string; value: string; options?: Record<string, unknown> };

// Mirrors createSupabaseServerClient's setAll (lib/supabase/server.ts) -
// correct there (Server Components can't set cookies during render and
// would otherwise crash), wrong for a Route Handler, which is exactly the
// bug this investigation found: a cookie-write failure here is silently
// absorbed instead of surfacing as a failed login.
function oldServerComponentSafeSetAll(cookieStore: { set: (name: string, value: string, options?: any) => void }, cookiesToSet: CookieToSet[]) {
  try {
    cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
  } catch {
    // The bug: silently swallowed, exactly like the real Server-Component
    // variant - a caller relying on this to throw never finds out.
  }
}

// Mirrors route.ts's own setAll - no try/catch, so a write failure
// propagates to the route's existing outer try/catch, which already
// correctly redirects to /sign-in?error=... instead of `next`.
function newRouteHandlerSetAll(cookieStore: { set: (name: string, value: string, options?: any) => void }, cookiesToSet: CookieToSet[]) {
  cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

function main() {
  // A real NextResponse.redirect(...) instance, same as both the real
  // route.ts and this test use - not a fake stand-in object.
  function buildThrowingResponse() {
    const response = NextResponse.redirect("https://example.com/dashboard");
    (response.cookies as any).set = () => {
      throw new Error("SIMULATED cookie-set failure (e.g. a real-world header-size limit or platform quirk)");
    };
    return response;
  }

  const cookiesToSet: CookieToSet[] = [{ name: "sb-access-token", value: "fake-session-value" }];

  // OLD pattern: the bug. A genuine cookie-write failure must NOT be
  // silently absorbed, but the old Server-Component-safe pattern does
  // exactly that - proving this is the failure mode being fixed.
  let oldThrew = false;
  try {
    oldServerComponentSafeSetAll(buildThrowingResponse().cookies, cookiesToSet);
  } catch {
    oldThrew = true;
  }
  check("OLD pattern (createSupabaseServerClient-style) silently swallows a cookie-write failure", oldThrew, false);

  // NEW pattern: the fix. The same failure must propagate, so route.ts's
  // real outer try/catch can turn it into a failed-login redirect instead
  // of forwarding the user to `next` as if they're logged in.
  let newThrew = false;
  let caughtMessage: string | null = null;
  try {
    newRouteHandlerSetAll(buildThrowingResponse().cookies, cookiesToSet);
  } catch (e) {
    newThrew = true;
    caughtMessage = (e as Error).message;
  }
  check("NEW pattern (route.ts's own setAll) propagates a cookie-write failure", newThrew, true);
  check("NEW pattern's propagated error is the real simulated failure, not something else", caughtMessage?.includes("SIMULATED cookie-set failure"), true);

  // Sanity check the other direction too - neither pattern should ever
  // interfere with a NORMAL, successful cookie write (no regression on the
  // happy path, which is by far the common case).
  const normalResponse = NextResponse.redirect("https://example.com/dashboard");
  let normalWriteThrew = false;
  try {
    newRouteHandlerSetAll(normalResponse.cookies, cookiesToSet);
  } catch {
    normalWriteThrew = true;
  }
  check("NEW pattern still writes a real cookie successfully on the normal (non-failing) path", normalWriteThrew, false);
  check("NEW pattern's successful write is actually visible on the response", normalResponse.cookies.get("sb-access-token")?.value, "fake-session-value");

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
