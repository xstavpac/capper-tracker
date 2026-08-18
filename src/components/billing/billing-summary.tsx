"use client";

import { useState } from "react";
import { createBillingPortalSessionAction } from "@/server/actions/billing";
import { TIER_LABELS, type Tier } from "@/lib/entitlements";

export function BillingSummary({
  tier,
  status,
  cancelAtPeriodEnd,
  currentPeriodEnd,
  hasStripeCustomer,
}: {
  tier: Tier;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null; // pre-formatted, Server Component can't pass a formatting function
  hasStripeCustomer: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleManageBilling() {
    setError(null);
    setLoading(true);
    const res = await createBillingPortalSessionAction(window.location.origin);
    if (res.success) {
      window.location.href = res.url;
    } else {
      setError(res.error);
      setLoading(false);
    }
  }

  return (
    <div className="rounded-card bg-card p-5 shadow-soft">
      <h3 className="mb-3 text-sm font-medium text-foreground">Plan</h3>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-lg font-semibold text-foreground">{TIER_LABELS[tier]}</div>
          {tier !== "FREE" && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {cancelAtPeriodEnd && currentPeriodEnd
                ? "Cancels " + currentPeriodEnd + " - you keep access until then."
                : status === "past_due"
                  ? "Payment issue - Stripe is retrying. Update your payment method to avoid losing access."
                  : currentPeriodEnd
                    ? "Renews " + currentPeriodEnd
                    : null}
            </p>
          )}
          {tier === "FREE" && <p className="mt-0.5 text-xs text-muted-foreground">1,000 tracked picks included.</p>}
        </div>
        <div className="flex items-center gap-2">
          {tier === "FREE" && (
            <a
              href="/pricing"
              className="rounded-full bg-brand-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-brand-700"
            >
              Upgrade
            </a>
          )}
          {hasStripeCustomer && (
            <button
              onClick={handleManageBilling}
              disabled={loading}
              className="rounded-full border border-border px-4 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted disabled:opacity-50"
            >
              {loading ? "Opening..." : "Manage billing"}
            </button>
          )}
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
