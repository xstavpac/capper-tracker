import Link from "next/link";

// Same logo-mark.png asset as the sidebar's LogoMark (app-sidebar.tsx) and
// the auth card's LogoMark (auth-card.tsx) - kept in sync visually rather
// than introducing a fourth copy of the same badge.
function LogoMark() {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- fixed local asset, not worth next/image's overhead at this size
    <img src="/logo-mark.png" alt="" className="h-12 w-12 shrink-0 rounded-2xl object-cover" aria-hidden="true" />
  );
}

export default function MarketingPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 px-6 text-center">
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
        <span className="text-xs text-gray-400">Free · No credit card required</span>
      </div>
    </main>
  );
}
