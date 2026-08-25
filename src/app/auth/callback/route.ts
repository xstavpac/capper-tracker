import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Where Supabase redirects back to after Google OAuth, an email
// confirmation link, or a password-reset link - `code` gets exchanged for a
// real session (setting the auth cookie via the server client), then we
// send the user on to wherever they were headed (?next=, e.g. /reset-
// password for the recovery flow, or the original protected route for a
// fresh sign-in).
//
// Deliberately does NOT reuse createSupabaseServerClient (lib/supabase/
// server.ts) - that factory's cookie setAll is wrapped in a silent
// try/catch, which is correct for its actual use case (Server Components,
// which genuinely cannot set cookies during render and would otherwise
// crash) but wrong here: this is a Route Handler, which both CAN and MUST
// be able to set cookies - this is the one request in the entire app where
// the real session cookie actually gets written for the first time. A
// swallowed failure here means exchangeCodeForSession can report success
// (it did - the code was valid) while the browser never actually receives
// a persisted session, and the user gets redirected to `next` looking
// logged in until the next real page load reveals they never were.
// Confirmed as the leading suspect for the "logged out on fresh navigation"
// bug report investigated 2026-08-25. `getAll`/`setAll` read from the
// incoming request and write directly onto the SAME
// NextResponse object this function returns (not through next/headers'
// ambient cookie jar), mirroring middleware.ts's own request-in/
// response-out split - so cookie writes are provably attached to the exact
// response the browser receives, not routed through an indirect mechanism.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (code) {
    // Supabase's client throws synchronously if its URL/key aren't
    // configured (same failure mode guarded against in middleware.ts and
    // server/auth.ts) - without this, a misconfigured env var turns into an
    // unhandled 500 crash page here instead of the graceful redirect every
    // other auth failure gets. Also now the catch target for a genuine
    // cookie-write failure (see setAll below) - either way, a failure here
    // must send the user to /sign-in with an error, never silently forward
    // them to `next` as if they're logged in.
    try {
      const response = NextResponse.redirect(`${origin}${next}`);
      const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
          cookies: {
            getAll() {
              return request.cookies.getAll();
            },
            setAll(cookiesToSet) {
              // No try/catch, by design - see the function-level comment
              // above. A throw here is caught by the surrounding try/catch
              // and correctly turned into a failed-login redirect instead
              // of being silently absorbed.
              cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
            },
          },
        }
      );

      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) {
        return response;
      }
      console.error("[auth/callback] exchangeCodeForSession failed:", error.message);
    } catch (err) {
      console.error("[auth/callback] Supabase client/session exchange threw:", err);
    }
  } else {
    console.error("[auth/callback] no ?code param on callback request. Full URL:", request.url);
  }

  return NextResponse.redirect(`${origin}/sign-in?error=auth_callback_failed`);
}
