"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createCheckoutSessionAction } from "@/server/actions/billing";
import type { Tier } from "@/lib/entitlements";

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-emerald-600" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-muted-foreground/50" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function Feature({ locked, children }: { locked?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      {locked ? <LockIcon /> : <CheckIcon />}
      <span className={locked ? "text-muted-foreground/70" : "text-foreground"}>{children}</span>
    </li>
  );
}

function CardShell({
  name,
  price,
  highlight,
  badge,
  children,
}: {
  name: string;
  price: string;
  highlight?: boolean;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        "flex flex-col rounded-card bg-card p-6 shadow-soft " + (highlight ? "ring-2 ring-brand-500" : "")
      }
    >
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-base font-semibold text-foreground">{name}</h2>
        {badge}
      </div>
      <div className="mb-4 text-2xl font-semibold text-foreground">{price}</div>
      {children}
    </div>
  );
}

function CurrentPlanBadge() {
  return (
    <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-600 dark:bg-brand-500/15 dark:text-brand-400">Current plan</span>
  );
}

export function PricingCards({ currentTier, checkoutStatus }: { currentTier: Tier; checkoutStatus?: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stripe redirects back here after Checkout. The page itself already
  // re-fetches entitlements fresh on this load (it's a Server Component), so
  // in the common case the webhook has already landed by the time the
  // browser gets redirected back - this is just a defensive one-shot
  // refresh in case it hasn't, so the "Current plan" badge doesn't need a
  // manual reload to catch up.
  useEffect(() => {
    if (checkoutStatus === "success") {
      const timer = setTimeout(() => router.refresh(), 2000);
      return () => clearTimeout(timer);
    }
  }, [checkoutStatus, router]);

  async function handleUpgrade() {
    setError(null);
    setLoading(true);
    const res = await createCheckoutSessionAction(window.location.origin);
    if (res.success) {
      window.location.href = res.url;
    } else {
      setError(res.error);
      setLoading(false);
    }
  }

  return (
    <div>
      {checkoutStatus === "success" && (
        <div className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
          Checkout complete - your plan will update in a moment.
        </div>
      )}
      {checkoutStatus === "cancelled" && (
        <div className="mb-4 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">Checkout cancelled - no changes were made.</div>
      )}
      {error && <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <CardShell name="Free" price="$0" badge={currentTier === "FREE" ? <CurrentPlanBadge /> : undefined}>
          <ul className="mb-6 space-y-2">
            <Feature>1,000 tracked picks</Feature>
            <Feature locked>Model Builder</Feature>
            <Feature locked>Charts</Feature>
          </ul>
          {currentTier === "FREE" && (
            <div className="mt-auto rounded-lg bg-muted px-3 py-2 text-center text-xs font-medium text-muted-foreground">
              Your current plan
            </div>
          )}
        </CardShell>

        <CardShell
          name="Basic"
          price="$5.99/mo"
          highlight
          badge={currentTier === "BASIC" ? <CurrentPlanBadge /> : undefined}
        >
          <ul className="mb-6 space-y-2">
            <Feature>Unlimited tracked picks</Feature>
            <Feature locked>Model Builder</Feature>
            <Feature locked>Charts</Feature>
          </ul>
          {currentTier === "FREE" && (
            <button
              onClick={handleUpgrade}
              disabled={loading}
              className="mt-auto rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-soft transition hover:bg-brand-700 disabled:opacity-50"
            >
              {loading ? "Starting checkout..." : "Upgrade to Basic"}
            </button>
          )}
          {currentTier === "BASIC" && (
            <div className="mt-auto rounded-lg bg-muted px-3 py-2 text-center text-xs font-medium text-muted-foreground">
              Your current plan
            </div>
          )}
          {currentTier === "PRO" && (
            <div className="mt-auto rounded-lg bg-muted px-3 py-2 text-center text-xs font-medium text-muted-foreground">
              Included in your Pro plan
            </div>
          )}
        </CardShell>

        <CardShell
          name="Pro"
          price="Coming soon"
          badge={currentTier === "PRO" ? <CurrentPlanBadge /> : undefined}
        >
          <ul className="mb-6 space-y-2">
            <Feature>Unlimited tracked picks</Feature>
            <Feature>Model Builder</Feature>
            <Feature>Charts</Feature>
            <Feature>Advanced features</Feature>
          </ul>
          <div className="mt-auto rounded-lg bg-muted px-3 py-2 text-center text-xs font-medium text-muted-foreground">
            Not yet available for purchase
          </div>
        </CardShell>
      </div>
    </div>
  );
}
