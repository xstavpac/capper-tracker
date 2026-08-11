"use server";

import { requireUser } from "@/server/auth";
import { getStripe, tierToPriceId } from "@/lib/stripe";
import { getSubscriptionForUser } from "@/server/data/subscriptions";

export type CheckoutActionResult = { success: true; url: string } | { success: false; error: string };

// `origin` comes from the client (window.location.origin), same pattern the
// existing OAuth sign-in flow already uses (see (auth)/sign-in/page.tsx) -
// keeps this correct on every domain the app is served from without
// hardcoding one, and without needing to parse it back out of request
// headers here.
export async function createCheckoutSessionAction(origin: string): Promise<CheckoutActionResult> {
  const user = await requireUser();

  try {
    const stripe = getStripe();
    const existing = await getSubscriptionForUser(user.id);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: tierToPriceId("BASIC"), quantity: 1 }],
      // Lets the webhook map this checkout back to our internal user without
      // relying on email matching (an existing Stripe customer id, if we
      // already have one for this user, takes priority - customer and
      // customer_email can't both be set).
      client_reference_id: user.id,
      ...(existing?.stripeCustomerId
        ? { customer: existing.stripeCustomerId }
        : { customer_email: user.email }),
      success_url: origin + "/pricing?checkout=success",
      cancel_url: origin + "/pricing?checkout=cancelled",
      allow_promotion_codes: true,
      // Stripe's own event ordering between checkout.session.completed and
      // customer.subscription.created isn't guaranteed - stamping userId
      // directly onto the resulting Subscription object's metadata lets the
      // webhook resolve the user from a subscription event alone, with no
      // dependency on checkout.session.completed having been processed
      // first to establish the stripeCustomerId -> userId link.
      subscription_data: { metadata: { userId: user.id } },
    });

    if (!session.url) return { success: false, error: "Stripe did not return a Checkout URL." };
    return { success: true, url: session.url };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not start checkout.";
    return { success: false, error: message };
  }
}

export type PortalActionResult = { success: true; url: string } | { success: false; error: string };

// The Billing Portal is Stripe-hosted account management - cancel, update
// payment method, view invoices. Requires an existing Stripe customer (i.e.
// this user has been through Checkout at least once); there's nothing to
// manage otherwise.
export async function createBillingPortalSessionAction(origin: string): Promise<PortalActionResult> {
  const user = await requireUser();

  const existing = await getSubscriptionForUser(user.id);
  if (!existing?.stripeCustomerId) {
    return { success: false, error: "No billing account yet - subscribe first to manage billing." };
  }

  try {
    const stripe = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: existing.stripeCustomerId,
      return_url: origin + "/settings",
    });
    return { success: true, url: session.url };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not open the billing portal.";
    return { success: false, error: message };
  }
}
