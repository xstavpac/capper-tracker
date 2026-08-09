import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

// Used by Server Components/Actions (server/auth.ts, the auth callback
// route) to read the current session from request cookies. The setAll
// no-op-catch is the standard @supabase/ssr pattern for Server Components,
// which can't write cookies themselves - middleware.ts is what actually
// refreshes/persists the session cookie on each request.
export async function createSupabaseServerClient() {
  const cookieStore = cookies();

  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component render - middleware already
          // refreshes the session cookie, so this is safe to ignore.
        }
      },
    },
  });
}
