import Link from "next/link";

// Finalized with real values from the site owner (Aug 17, 2026) - the
// Payment Information paragraph and Stripe bullet from the original draft
// were deliberately dropped, not just filled in: billing isn't live, and
// the owner's finalized text doesn't mention Stripe at all. Re-add both if
// billing goes live later - see git history for the original conditional
// wording.
export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 text-gray-700">
      <Link href="/" className="text-sm font-medium text-brand-600 hover:text-brand-700">
        &larr; Back to Bettingview
      </Link>

      <h1 className="mt-6 text-3xl font-semibold tracking-tight text-gray-900">BettingView Privacy Policy</h1>
      <p className="mt-2 text-sm font-medium text-gray-500">Last updated: August 17, 2026</p>

      <p className="mt-6 leading-relaxed">
        This Privacy Policy explains how BettingView (&ldquo;we,&rdquo; &ldquo;us,&rdquo; &ldquo;our&rdquo;) collects,
        uses, and protects information when you use bettingview.app (the &ldquo;Service&rdquo;).
      </p>

      <h2 className="mt-10 text-xl font-semibold text-gray-900">Information We Collect</h2>

      <p className="mt-4 leading-relaxed">
        <strong className="font-semibold text-gray-900">Account information.</strong> When you sign in with Google,
        we receive your name, email address, and profile picture from your Google account. We use this solely to
        create and manage your BettingView account and to identify you within the Service.{" "}
        <strong className="font-semibold text-gray-900">
          We do not access your Gmail, Google Drive, Google Calendar, or any other Google data beyond this basic
          sign-in information.
        </strong>
      </p>

      <p className="mt-4 leading-relaxed">
        <strong className="font-semibold text-gray-900">Content you provide.</strong> This includes the cappers you
        track, the picks you log or import, notes, favorites, and any other information you enter into the Service.
      </p>

      <p className="mt-4 leading-relaxed">
        <strong className="font-semibold text-gray-900">Usage data.</strong> We automatically collect basic technical
        information when you use the Service &mdash; such as pages visited, actions taken, browser type, and device
        information &mdash; to keep the Service working correctly and to understand how it&apos;s used.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-gray-900">How We Use Information</h2>

      <p className="mt-4 leading-relaxed">We use the information we collect to:</p>
      <ul className="mt-3 list-disc space-y-1.5 pl-5">
        <li>Provide, maintain, and improve the Service</li>
        <li>Authenticate your account and keep it secure</li>
        <li>Track and display the pick/capper data you&apos;ve chosen to log</li>
        <li>Communicate with you about your account or the Service</li>
        <li>Detect and prevent fraud, abuse, or technical issues</li>
      </ul>

      <h2 className="mt-10 text-xl font-semibold text-gray-900">How We Share Information</h2>

      <p className="mt-4 leading-relaxed">We do not sell your personal information.</p>

      <p className="mt-4 leading-relaxed">
        We share information only with the service providers necessary to operate BettingView, including:
      </p>
      <ul className="mt-3 list-disc space-y-1.5 pl-5">
        <li>
          <strong className="font-semibold text-gray-900">Supabase</strong> &mdash; our database and authentication
          provider
        </li>
        <li>
          <strong className="font-semibold text-gray-900">Vercel</strong> &mdash; our hosting provider
        </li>
        <li>
          <strong className="font-semibold text-gray-900">The Odds API</strong> &mdash; for live sports odds and
          scores
        </li>
      </ul>

      <p className="mt-4 leading-relaxed">
        These providers only receive the information necessary to perform their function and are not permitted to
        use it for their own purposes.
      </p>

      <p className="mt-4 leading-relaxed">
        We may also disclose information if required by law, or to protect the rights, safety, or property of
        BettingView or our users.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-gray-900">Data Retention</h2>

      <p className="mt-4 leading-relaxed">
        We retain your account information for as long as your account is active. If you delete your account, we
        will delete or anonymize your personal information within 30 days, except where we&apos;re required to
        retain it for legal or security purposes.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-gray-900">Your Rights</h2>

      <p className="mt-4 leading-relaxed">You can:</p>
      <ul className="mt-3 list-disc space-y-1.5 pl-5">
        <li>Access or update your account information directly within the Service</li>
        <li>
          Request deletion of your account and associated data by contacting us at{" "}
          <a href="mailto:Bettingview@proton.me" className="font-medium text-brand-600 hover:text-brand-700">
            Bettingview@proton.me
          </a>
        </li>
        <li>
          Revoke BettingView&apos;s access to your Google account at any time via your{" "}
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-brand-600 hover:text-brand-700"
          >
            Google Account permissions page
          </a>
        </li>
      </ul>

      <h2 className="mt-10 text-xl font-semibold text-gray-900">Data Security</h2>

      <p className="mt-4 leading-relaxed">
        We use industry-standard measures to protect your information, including encrypted connections (HTTPS) and
        access controls on our database. No system is perfectly secure, and we can&apos;t guarantee absolute
        security, but we take reasonable steps to protect your data.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-gray-900">Children&apos;s Privacy</h2>

      <p className="mt-4 leading-relaxed">
        BettingView is not directed at, and is not intended for use by, anyone under the age of 18. We do not
        knowingly collect information from anyone under 18. If you believe a minor has provided us with information,
        contact us at{" "}
        <a href="mailto:Bettingview@proton.me" className="font-medium text-brand-600 hover:text-brand-700">
          Bettingview@proton.me
        </a>{" "}
        and we will delete it.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-gray-900">Changes to This Policy</h2>

      <p className="mt-4 leading-relaxed">
        We may update this Privacy Policy from time to time. If we make material changes, we&apos;ll update the
        &ldquo;Last updated&rdquo; date above and, where appropriate, notify you directly.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-gray-900">Contact Us</h2>

      <p className="mt-4 leading-relaxed">
        If you have questions about this Privacy Policy or how your information is handled, contact us at:
      </p>
      <p className="mt-3 font-semibold text-gray-900">
        <a href="mailto:Bettingview@proton.me" className="text-brand-600 hover:text-brand-700">
          Bettingview@proton.me
        </a>
      </p>
    </main>
  );
}
