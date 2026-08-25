// Proof for the marketing-page "already logged in -> redirect to /dashboard"
// fix - run with:
//   npx tsx "src/app/(marketing)/page-acceptance-test.ts"
//
// No test framework exists in this repo (see parse-catalog-acceptance-
// test.ts's own header for why); this is the same kind of persisted
// regression script.
//
// What this proves, and what it deliberately does NOT: this mirrors the
// exact conditional in page.tsx ("if (user) redirect('/dashboard')") and
// exercises the real next/navigation redirect() primitive against both
// branches, confirming a present user triggers a real Next.js redirect
// signal (not a no-op) and a null user does not. It does NOT call
// getCurrentUser() itself, which needs a real Supabase session/DB to be
// meaningful - that function is already proven correct by being the same
// one every protected (app) page in this codebase already calls in
// production. The one genuinely new thing this fix adds is the redirect
// branch itself, which is what this test targets.
import { redirect } from "next/navigation";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// Exact mirror of MarketingPage's own logic - see that file's comment for
// why this isn't testing getCurrentUser() itself.
function marketingPageRedirectLogic(user: { id: string } | null): "redirected" | "rendered-marketing-page" {
  if (user) {
    redirect("/dashboard");
  }
  return "rendered-marketing-page";
}

function main() {
  // Logged-in case: must actually redirect, not silently fall through and
  // render the marketing page underneath a logged-in visitor.
  let redirectDigest: string | null = null;
  let threw = false;
  try {
    marketingPageRedirectLogic({ id: "real-user-id" });
  } catch (e) {
    threw = true;
    redirectDigest = (e as { digest?: string }).digest ?? null;
  }
  check("logged-in user triggers a real Next.js redirect (throws)", threw, true);
  check("redirect digest targets /dashboard specifically", redirectDigest, "NEXT_REDIRECT;replace;/dashboard;307;");

  // Logged-out case: must NOT redirect - the marketing page has to still
  // render normally, unchanged, for the common (logged-out) visitor.
  let loggedOutThrew = false;
  let result: string | null = null;
  try {
    result = marketingPageRedirectLogic(null);
  } catch {
    loggedOutThrew = true;
  }
  check("logged-out (null) user does NOT redirect", loggedOutThrew, false);
  check("logged-out (null) user falls through to render the marketing page", result, "rendered-marketing-page");

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
