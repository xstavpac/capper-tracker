import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { sessionUserFromClaims } from "@/lib/supabase/claims";

// Standard @supabase/ssr middleware pattern: refreshes the auth cookie on
// every request (access tokens are short-lived) and returns both the
// possibly-updated response and whether a session currently exists, so
// middleware.ts can decide whether to redirect to /sign-in without a second
// round-trip.
//
// Uses getClaims(), NOT getUser() (M2 - see docs/m2-auth-round-trips.md). This
// project signs JWTs with an asymmetric key (ES256), so getClaims() verifies
// the token's signature LOCALLY via WebCrypto against a cached JWKS (10-min
// TTL, shared process-wide) - no round-trip to the Auth server on the hot
// path. getSession(), which getClaims() calls internally, still performs the
// on-expiry token refresh (within 90s of expiry) and writes the new cookie
// through setAll below, so the refresh responsibility this middleware carries
// is unchanged. getUser() by contrast hit GET /auth/v1/user on every single
// request, and this ran again in getCurrentUser() - two serial Auth calls
// before any app code.
export async function updateSupabaseSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    }
  );

  const { data } = await supabase.auth.getClaims();
  return { response, user: sessionUserFromClaims(data) };
}
