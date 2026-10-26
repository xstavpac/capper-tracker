import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isDevAuthBypassEnabled, DEV_BYPASS_SUPABASE_ID, DEV_BYPASS_EMAIL, DEV_BYPASS_NAME } from "@/lib/dev-auth-bypass";
import { authUserFromClaims, type AuthUser } from "@/lib/supabase/claims";

// The verified identity for this request, with no database read. Split out of
// auth.ts (which reads and may create the users row) so a route that only needs
// "is someone signed in" - /api/live/scores, polled every 25 s - does not pay a
// `users` lookup per call. Nothing here is cached across requests or users:
// every call re-reads the request's own cookies and re-verifies the token.
//
// getClaims(), not getUser(): see getCurrentUser's note in auth.ts and
// docs/m2-auth-round-trips.md. The same tradeoff applies - a banned or deleted
// user keeps access until their access token expires (<= ~1h).
export type GetClaims = () => Promise<{ data?: { claims?: Parameters<typeof authUserFromClaims>[0] } | null }>;

async function supabaseGetClaims(): ReturnType<GetClaims> {
  const supabase = await createSupabaseServerClient();
  return supabase.auth.getClaims();
}

// No token, an expired token, and a signature that fails verification all come
// back from getClaims() as { data: null, error }, and resolve to null here.
export async function resolveAuthUser(getClaims: GetClaims = supabaseGetClaims): Promise<AuthUser | null> {
  // Local-dev-only - see lib/dev-auth-bypass.ts.
  if (isDevAuthBypassEnabled()) {
    return { id: DEV_BYPASS_SUPABASE_ID, email: DEV_BYPASS_EMAIL, user_metadata: { full_name: DEV_BYPASS_NAME } };
  }
  // Middleware already gates every protected route on a resolved session, but
  // guard here too (defense in depth) - Supabase's client throws synchronously
  // if its URL/key aren't configured, and that would 500 the whole request
  // instead of just failing auth.
  try {
    const { data } = await getClaims();
    return authUserFromClaims(data?.claims);
  } catch (err) {
    console.error("[auth] Supabase session check failed:", err);
    return null;
  }
}

// Throws "Not authenticated" like requireUser(). Returns the verified claims'
// identity, NOT a users row: it never creates the row and never reads it.
export async function requireSession(getClaims?: GetClaims): Promise<AuthUser> {
  const authUser = await resolveAuthUser(getClaims);
  if (!authUser) throw new Error("Not authenticated");
  return authUser;
}
