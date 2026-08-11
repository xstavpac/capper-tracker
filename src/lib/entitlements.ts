// Pure tier/feature-gating logic - no DB access (that lives in
// server/data/subscriptions.ts). Kept here, not there, so it's trivially
// unit-testable and importable anywhere without pulling in Prisma.

export type Tier = "FREE" | "BASIC" | "PRO";

export const FREE_PICK_LIMIT = 1000;

// The subset of Subscription fields entitlement resolution actually needs -
// a plain shape rather than the full Prisma model, so this stays decoupled
// from the ORM and easy to construct in tests.
export type SubscriptionState = {
  plan: Tier;
  status: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
} | null;

// Whether a subscription's PAID tier (plan) is actually in effect right now.
// This is the one place that translates Stripe's real subscription lifecycle
// into a yes/no - every other check in this app should go through this
// (or resolveEffectiveTier below), never read `plan`/`status` directly.
//
// - active / trialing / past_due: paid tier in effect ONLY IF the stored
//   currentPeriodEnd is still in the future, checked against the real clock
//   on every call (never cached). This is a defense-in-depth ceiling, not a
//   replacement for the webhook sync: normally `active` alone would be
//   enough (Stripe holds status "active" through the whole cancel_at_period_end
//   grace window, and past_due's currentPeriodEnd is the still-being-retried
//   period's end), but if the webhook that would eventually flip status away
//   from one of these (customer.subscription.updated/deleted) is delayed,
//   the DB row can lag Stripe's real state - this ceiling guarantees access
//   never outlasts the period actually paid for, independent of webhook
//   timing.
// - canceled: this is NOT one signal, it's two different real-world shapes
//   that both land on status "canceled" and must be told apart using
//   cancel_at_period_end, not currentPeriodEnd alone:
//     - Immediate cancellation (cancel_at_period_end: false): Stripe does
//       NOT roll currentPeriodEnd back to "now" just because the
//       cancellation was immediate - it's left pointing at the end of
//       whatever billing period was already in progress, which can still be
//       weeks in the future. Confirmed empirically (an admin "cancel
//       immediately" from the Stripe Dashboard produces exactly
//       status: canceled, cancel_at_period_end: false, currentPeriodEnd:
//       still ~a month out) - not a rare edge case, the normal shape of an
//       immediate cancel. Access ends now, full stop, regardless of
//       currentPeriodEnd.
//     - Scheduled cancellation reaching its natural end
//       (cancel_at_period_end: true): currentPeriodEnd is still the real
//       boundary here - by the time Stripe actually flips status to
//       "canceled" this way, currentPeriodEnd has normally already passed,
//       so this is mostly a defensive check against a delayed webhook
//       (same reasoning as the active/trialing/past_due ceiling above).
// - unpaid: NOT entitled - Stripe's terminal "retries exhausted, not being
//   paid" status (reachable if the account's dunning settings are configured
//   to move here instead of auto-canceling). Treated as lost access.
// - anything else (incomplete, incomplete_expired, paused, or no
//   subscription at all): NOT entitled.
export function isEntitledToPaidTier(sub: SubscriptionState): boolean {
  if (!sub || sub.plan === "FREE") return false;
  switch (sub.status) {
    case "active":
    case "trialing":
    case "past_due":
      return sub.currentPeriodEnd !== null && sub.currentPeriodEnd > new Date();
    case "canceled":
      if (!sub.cancelAtPeriodEnd) return false; // immediate cancellation - access ends now
      return sub.currentPeriodEnd !== null && sub.currentPeriodEnd > new Date();
    default:
      return false; // unpaid, incomplete, incomplete_expired, paused, etc.
  }
}

// The tier that should actually govern this user's access right now - their
// paid plan if isEntitledToPaidTier says it's still in effect, otherwise
// FREE regardless of what `plan` says (plan reflects "what they last paid
// for", not "what they're entitled to this second").
export function resolveEffectiveTier(sub: SubscriptionState): Tier {
  return isEntitledToPaidTier(sub) ? sub!.plan : "FREE";
}

export type FeatureKey = "model_builder" | "charts";

// One row per tier. Deliberately a flat table, not scattered `if` checks -
// changing what Pro unlocks later (or adding a feature) is editing one row
// here, not touching the billing/webhook/pick-limit code at all.
const TIER_FEATURES: Record<Tier, Record<FeatureKey, boolean>> = {
  FREE: { model_builder: false, charts: false },
  BASIC: { model_builder: false, charts: false },
  PRO: { model_builder: true, charts: true },
};

export function hasFeature(tier: Tier, feature: FeatureKey): boolean {
  return TIER_FEATURES[tier][feature];
}

export const TIER_LABELS: Record<Tier, string> = { FREE: "Free", BASIC: "Basic", PRO: "Pro" };
