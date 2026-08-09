import { createBrowserClient } from "@supabase/ssr";

// Used by the sign-in/sign-up pages (client components) for interactive
// Google OAuth + email/password calls. Safe to call repeatedly - the SDK
// reuses the same underlying session storage.
export function createSupabaseBrowserClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
