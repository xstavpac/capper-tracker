import Link from "next/link";

// Same purple + target-arrow mark as the sidebar's LogoMark (app-sidebar.tsx)
// - kept in sync visually with the rest of the app, unlike the new brand-
// purple (#7F2FD4) used for this page's primary buttons, which is a
// separate, explicitly-requested color.
function LogoMark() {
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#7F77DD]">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="white"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-5 w-5"
        aria-hidden="true"
      >
        <circle cx="10" cy="14" r="6.5" />
        <circle cx="10" cy="14" r="2.5" />
        <path d="M14.5 9.5L21 3" />
        <path d="M21 7.5V3h-4.5" />
      </svg>
    </div>
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
}: {
  heading: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10">
      <div className="w-full max-w-[340px] rounded-2xl bg-white p-8 shadow-soft">
        <Link href="/" className="mb-6 flex items-center gap-2.5">
          <LogoMark />
          <span className="text-lg font-semibold text-gray-900">Capper Tracker</span>
        </Link>
        <h1 className="text-2xl font-semibold text-gray-900">{heading}</h1>
        <p className="mt-1 text-sm text-gray-500">{subtitle}</p>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}
