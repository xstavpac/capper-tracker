import { NextResponse } from "next/server";
import { auth } from "@/auth";

// Everything under (app) requires a signed-in user.
// Marketing pages, sign-in, webhooks, and cron routes stay public
// (cron routes have no session - they authenticate via CRON_SECRET instead).
const PUBLIC_ROUTES = [/^\/$/, /^\/sign-in/, /^\/api\/auth/, /^\/api\/webhooks/, /^\/api\/cron/];

export default auth((req) => {
  const isPublic = PUBLIC_ROUTES.some((re) => re.test(req.nextUrl.pathname));
  if (!isPublic && !req.auth) {
    const signInUrl = new URL("/sign-in", req.nextUrl.origin);
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
