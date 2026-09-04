import Link from "next/link";

// Same logo-mark.png asset as the sidebar's LogoMark (app-sidebar.tsx) - kept
// in sync visually with the rest of the app, unlike the new brand-purple
// (#7F2FD4) used for this page's primary buttons, which is a separate,
// explicitly-requested color. The asset is a full lockup (icon + divider +
// "Bettingview" wordmark) now, not just an icon - sized by height with
// w-auto to preserve its real aspect ratio instead of squashing it into the
// old square badge.
function LogoMark() {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- fixed local asset, not worth next/image's overhead at this size
    <img src="/logo-mark.png" alt="Bettingview" className="h-16 w-auto shrink-0" />
  );
}

export const AUTH_PRIMARY_BUTTON_CLASS =
  "w-full rounded-lg bg-[#7F2FD4] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#6b26b3] disabled:cursor-not-allowed disabled:opacity-60";

export const AUTH_INPUT_CLASS =
  "w-full rounded-lg border border-gray-200 px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-[#7F2FD4] focus:outline-none focus:ring-1 focus:ring-[#7F2FD4]";

export function AuthCard({
  heading,
  subtitle,
  children,
  // When true, render just the card - no full-screen centering/background
  // wrapper. Used by the sign-in page, which drops the card into the center
  // slot of <OracleBackground> and does its own centering. The other auth
  // pages (sign-up, forgot/reset password) leave this false.
  bare = false,
}: {
  heading: string;
  subtitle: string;
  children: React.ReactNode;
  bare?: boolean;
}) {
  const card = (
    <div className="w-full max-w-[340px] rounded-2xl bg-white p-8 shadow-soft">
      <Link href="/" className="mb-6 block">
        <LogoMark />
      </Link>
      <h1 className="text-2xl font-semibold text-gray-900">{heading}</h1>
      <p className="mt-1 text-sm text-gray-500">{subtitle}</p>
      <div className="mt-6">{children}</div>
    </div>
  );

  if (bare) return card;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10">{card}</div>
  );
}
