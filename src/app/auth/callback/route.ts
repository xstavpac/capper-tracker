import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Where Supabase redirects back to after Google OAuth, an email
// confirmation link, or a password-reset link - `code` gets exchanged for a
// real session (setting the auth cookie via the server client), then we
// send the user on to wherever they were headed (?next=, e.g. /reset-
// password for the recovery flow, or the original protected route for a
// fresh sign-in).
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (code) {
    // Supabase's client throws synchronously if its URL/key aren't
    // configured (same failure mode guarded against in middleware.ts and
    // server/auth.ts) - without this, a misconfigured env var turns into an
    // unhandled 500 crash page here instead of the graceful redirect every
    // other auth failure gets.
    try {
      const supabase = await createSupabaseServerClient();
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) {
        return NextResponse.redirect(`${origin}${next}`);
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
