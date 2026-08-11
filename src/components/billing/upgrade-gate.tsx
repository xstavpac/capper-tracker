// Shown in place of a Pro-only page's real content when the user's
// server-verified entitlements don't include that feature - see
// model-builder/page.tsx and charts/page.tsx. Deliberately not a redirect;
// landing on the real URL and seeing exactly what's locked (rather than
// bouncing away) is clearer about why, and links straight to /pricing.
export function UpgradeGate({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-6 rounded-card bg-white p-10 text-center shadow-soft">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-gray-100">
        <svg viewBox="0 0 24 24" className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="4" y="10" width="16" height="10" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
      </div>
      <h1 className="text-lg font-semibold text-gray-900">{title}</h1>
      <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">{description}</p>
      <a
        href="/pricing"
        className="mt-4 inline-block rounded-full bg-brand-600 px-5 py-2 text-sm font-medium text-white shadow-soft transition hover:bg-brand-700"
      >
        See plans
      </a>
    </div>
  );
}
