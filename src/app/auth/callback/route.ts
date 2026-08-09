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
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
    // TEMPORARY - diagnosing the "flickers back to sign-in" report, remove
    // once the real cause is confirmed and fixed.
    console.error("[auth/callback] exchangeCodeForSession failed:", {
      name: error.name,
      status: error.status,
      code: (error as { code?: string }).code,
      message: error.message,
    });
  } else {
    console.error("[auth/callback] no ?code param on callback request. Full URL:", request.url);
  }

  return NextResponse.redirect(`${origin}/sign-in?error=auth_callback_failed`);
}
