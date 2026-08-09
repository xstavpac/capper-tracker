import { NextResponse, type NextRequest } from "next/server";
import { updateSupabaseSession } from "@/lib/supabase/middleware";

// Everything under (app) requires a signed-in user.
// Marketing pages, sign-in/sign-up, the Supabase auth callback, webhooks,
// and cron routes stay public (cron routes have no session - they
// authenticate via CRON_SECRET instead).
const PUBLIC_ROUTES = [
  /^\/$/,
  /^\/sign-in/,
  /^\/sign-up/,
  /^\/reset-password/,
  /^\/auth\/callback/,
  /^\/api\/webhooks/,
  /^\/api\/cron/,
];

export default async function middleware(req: NextRequest) {
  const isPublic = PUBLIC_ROUTES.some((re) => re.test(req.nextUrl.pathname));

  // Supabase's client throws synchronously if its URL/key aren't configured
  // (e.g. env vars not yet set in this deployment) - since this runs on
  // every request, an unhandled throw here would 500 the entire site,
  // including the public marketing page. Degrade to "no session" instead:
  // public routes still serve fine, protected routes correctly bounce to
  // /sign-in (which itself just won't be able to complete a real sign-in
  // until the env vars are set) rather than every route going down.
  let response = NextResponse.next({ request: req });
  let user = null;
  try {
    ({ response, user } = await updateSupabaseSession(req));
  } catch (err) {
    console.error("[middleware] Supabase session check failed:", err);
  }

  if (!isPublic && !user) {
    const signInUrl = new URL("/sign-in", req.nextUrl.origin);
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
