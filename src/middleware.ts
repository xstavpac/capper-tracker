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
  const { response, user } = await updateSupabaseSession(req);

  const isPublic = PUBLIC_ROUTES.some((re) => re.test(req.nextUrl.pathname));
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
