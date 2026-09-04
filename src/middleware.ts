import { NextResponse, type NextRequest } from "next/server";
import { updateSupabaseSession } from "@/lib/supabase/middleware";
import { isDevAuthBypassEnabled, DEV_BYPASS_SUPABASE_ID } from "@/lib/dev-auth-bypass";

// Everything under (app) requires a signed-in user.
// Marketing pages (including the public Privacy Policy - Google's OAuth
// verification requires it be reachable logged-out), sign-in/sign-up, the
// Supabase auth callback, webhooks, and cron routes stay public (cron
// routes have no session - they authenticate via CRON_SECRET instead).
const PUBLIC_ROUTES = [
  /^\/$/,
  /^\/privacy/,
  /^\/sign-in/,
  /^\/sign-up/,
  /^\/reset-password/,
  /^\/auth\/callback/,
  /^\/api\/webhooks/,
  /^\/api\/cron/,
  // The marketing page's live-score ticker (see
  // components/marketing/live-ticker.tsx) polls this from a logged-out
  // visitor's browser - it has no session to be public alongside.
  /^\/api\/public\//,
];

// Routes whose content never depends on session state - safe to leave
// cacheable (and therefore browser-back-forward-cache-eligible) for
// performance. Every other page middleware touches gets Cache-Control:
// no-store below, so the browser's bfcache can't serve a stale
// authenticated (or stale logged-out) page snapshot after a login/logout -
// confirmed as a real gap during the "session isn't persisting" bug
// investigation (production was sending `public, max-age=0,
// must-revalidate`, which doesn't reliably block bfcache the way no-store
// does). API routes are deliberately left alone too - they're not full
// page navigations, so they were never subject to bfcache the same way,
// and touching them isn't needed to fix this bug.
const CACHEABLE_ROUTES = [/^\/$/, /^\/privacy/];

export default async function middleware(req: NextRequest) {
  const isPublic = PUBLIC_ROUTES.some((re) => re.test(req.nextUrl.pathname));
  const isCacheable = CACHEABLE_ROUTES.some((re) => re.test(req.nextUrl.pathname));
  const isApiRoute = req.nextUrl.pathname.startsWith("/api/") || req.nextUrl.pathname.startsWith("/trpc/");

  // Supabase's client throws synchronously if its URL/key aren't configured
  // (e.g. env vars not yet set in this deployment) - since this runs on
  // every request, an unhandled throw here would 500 the entire site,
  // including the public marketing page. Degrade to "no session" instead:
  // public routes still serve fine, protected routes correctly bounce to
  // /sign-in (which itself just won't be able to complete a real sign-in
  // until the env vars are set) rather than every route going down.
  let response = NextResponse.next({ request: req });
  let user = null;
  if (isDevAuthBypassEnabled()) {
    // Local-dev-only - see lib/dev-auth-bypass.ts. Skips the real Supabase
    // session check; getCurrentUser() (server/auth.ts) does the matching
    // skip for the actual user lookup below.
    user = { id: DEV_BYPASS_SUPABASE_ID };
  } else {
    try {
      ({ response, user } = await updateSupabaseSession(req));
    } catch (err) {
      console.error("[middleware] Supabase session check failed:", err);
    }
  }

  if (!isPublic && !user) {
    const signInUrl = new URL("/sign-in", req.nextUrl.origin);
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    response = NextResponse.redirect(signInUrl);
  }

  if (!isCacheable && !isApiRoute) {
    response.headers.set("Cache-Control", "no-store");
  }

  return response;
}

export const config = {
  matcher: [
    // mp4 added for the marketing homepage's background video
    // (public/videos/homepage-background.mp4, see (marketing)/page.tsx) -
    // without it this static asset falls through to the !isPublic branch
    // above and every logged-out request for it 307s to /sign-in, since
    // "/videos/..." isn't in PUBLIC_ROUTES. Same treatment as the other
    // static file types already excluded here (png, svg, etc.).
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|mp4|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
