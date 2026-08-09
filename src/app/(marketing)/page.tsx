import Link from "next/link";

export default function MarketingPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">
        Know who actually makes you money.
      </h1>
      <p className="max-w-xl text-lg text-gray-600">
        Capper Tracker is a private analytics platform for tracking the
        sports betting cappers you follow — from Twitter, Discord, Telegram,
        DubClub, or a friend. Log every pick, and we calculate the rest.
      </p>
      <div className="flex gap-3">
        <Link
          href="/sign-in"
          className="rounded-full bg-brand-600 px-6 py-3 font-medium text-white shadow-soft transition hover:bg-brand-700"
        >
          Get started free
        </Link>
      </div>
    </main>
  );
}
