import Link from "next/link";

// Small, purely-informational footer for the public marketing pages -
// deliberately not a nav bar (no app links, no sidebar equivalent). Its
// only job today is making the Privacy Policy reachable from the page a
// logged-out visitor (or Google's OAuth verification reviewer) actually
// lands on.
export function SiteFooter() {
  return (
    <footer className="mx-auto max-w-3xl px-6 py-8 text-center">
      <Link href="/privacy" className="text-xs text-gray-400 hover:text-gray-600">
        Privacy Policy
      </Link>
    </footer>
  );
}
