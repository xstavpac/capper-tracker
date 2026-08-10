// Lets local dev skip real Supabase sign-in entirely, so verifying a UI
// change doesn't require a live production deploy just to get logged in.
// Gated on two independent conditions, both required:
//   1. NODE_ENV === "development" - Next.js sets this only under `next dev`;
//      any built/deployed app (`next build` + `next start`, which is what
//      Vercel always runs, preview or production) has NODE_ENV=production
//      regardless of other env vars, so this alone already makes the bypass
//      structurally impossible in a real deployment.
//   2. DEV_AUTH_BYPASS=true - an explicit opt-in you set in your own
//      untracked .env.local (never .env, never committed), so the bypass
//      stays off even in local dev unless you turn it on deliberately.
//
// See README.md "Local dev auth bypass" for setup and the account details.
export function isDevAuthBypassEnabled(): boolean {
  return process.env.NODE_ENV === "development" && process.env.DEV_AUTH_BYPASS === "true";
}

// Sentinel identity for the bypass account - findOrCreate'd through the same
// upsertUserFromSupabase() path a real first-time sign-in uses (see
// server/auth.ts), so it's a completely ordinary FREE-plan User row with its
// own id, not a faked in-memory object special-cased through the rest of the
// app. The .test TLD is reserved by RFC 2606 specifically so this can never
// collide with or resemble a real, reachable email address.
export const DEV_BYPASS_SUPABASE_ID = "dev-local-bypass";
export const DEV_BYPASS_EMAIL = "dev-local@bettingview.test";
export const DEV_BYPASS_NAME = "Local Dev Test User";
