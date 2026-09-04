import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { SiteFooter } from "@/components/marketing/site-footer";

// Same logo-mark.png asset as the sidebar's LogoMark (app-sidebar.tsx) and
// the auth card's LogoMark (auth-card.tsx) - kept in sync visually rather
// than introducing a fourth copy of the same badge. Full lockup (icon +
// divider + "Bettingview" wordmark) now, so this is the hero's only
// "Bettingview" text - the headline itself never repeated the brand name.
function LogoMark() {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- fixed local asset, not worth next/image's overhead at this size
    <img src="/logo-mark.png" alt="Bettingview" className="h-32 w-auto shrink-0" />
  );
}

// This root route is deliberately PUBLIC in middleware.ts (PUBLIC_ROUTES
// includes "/") so a logged-out visitor can always reach it - that part is
// unchanged. But the page itself never used to check session state at all,
// so a logged-IN visitor who typed the bare domain fresh (rather than
// following a link straight to /dashboard) saw this generic marketing page
// every single time, not intermittently - confirmed as a real, distinct
// gap during the "session isn't persisting" investigation, separate from
// the auth-callback cookie fix and the bfcache Cache-Control fix. Reuses
// getCurrentUser() (server/auth.ts) - the same function every protected
// (app) page already calls - rather than a new/lighter-weight session
// check, so this stays consistent with how the rest of the app determines
// "am I logged in" and inherits its existing graceful-degradation-to-null
// behavior if Supabase is ever misconfigured (this page still renders the
// public marketing content in that case, never crashes).
export default async function MarketingPage() {
  const user = await getCurrentUser();
  if (user) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen flex-col">
      {/* relative + overflow-hidden turns this into the video's containing
          box; the video and its readability overlay are absolutely
          positioned behind the hero content (z-10) rather than affecting
          its layout. */}
      <main className="relative flex flex-1 flex-col items-center justify-center overflow-hidden">
        {/* Full-bleed, decorative, silent, looping - autoPlay+muted+loop+
            playsInline is what lets it autoplay across browsers (playsInline
            in particular avoids iOS Safari forcing fullscreen playback).
            object-cover fills the section on any screen size without
            distorting the footage; pointer-events-none keeps it from ever
            intercepting clicks meant for the button/links on top of it. */}
        <video
          className="pointer-events-none absolute inset-0 h-full w-full object-cover"
          src="/videos/homepage-background.mp4"
          autoPlay
          muted
          loop
          playsInline
          aria-hidden="true"
        />
        {/* The footage is soft/blurred abstract motion, but still needs a
            light scrim so the dark headline/body text stay easily legible
            over it - matches the page's existing light background instead
            of introducing a new tone. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-white/70" />

        <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center gap-6 px-6 text-center">
          <LogoMark />
          <h1 className="text-4xl font-semibold tracking-tight">
            Know who actually makes you money.
          </h1>
          <p className="max-w-xl text-lg text-gray-600">
            Bettingview is a private analytics platform for tracking the
            sports betting cappers you follow — from Twitter, Discord, Telegram,
            or a friend. Drop your catalog, and we calculate the rest.
          </p>
          <div className="flex flex-col items-center gap-2">
            <Link
              href="/sign-in"
              className="rounded-full bg-brand-600 px-6 py-3 font-medium text-white shadow-soft transition hover:bg-brand-700"
            >
              Get started free
            </Link>
            <span className="text-xs text-gray-400">1,000 free picks · No credit card required</span>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
