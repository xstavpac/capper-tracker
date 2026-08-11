import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe, priceIdToTier } from "@/lib/stripe";
import {
  findUserIdByStripeCustomerId,
  markWebhookEventProcessed,
  setStripeCustomerId,
  syncSubscriptionFromStripe,
} from "@/server/data/subscriptions";

export const dynamic = "force-dynamic";

// Every event type this endpoint actually acts on. Anything else still gets
// a 200 (Stripe expects 2xx for any event sent to a registered endpoint,
// not just ones we care about - returning non-2xx for an unhandled type
// would make Stripe retry it forever for no reason), just with no effect.
const HANDLED_TYPES = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
]);

function resolveUserId(subscription: Stripe.Subscription): string | null {
  return (subscription.metadata?.userId as string | undefined) ?? null;
}

async function syncFromSubscriptionObject(userId: string, subscription: Stripe.Subscription) {
  const item = subscription.items.data[0];
  const priceId = item?.price?.id ?? null;
  const tier = priceIdToTier(priceId);
  // current_period_end lives on the subscription item, not the subscription
  // itself, as of this SDK/API version - a subscription can in principle
  // have multiple items with different periods, though this app only ever
  // creates single-item subscriptions.
  const currentPeriodEnd = item?.current_period_end ? new Date(item.current_period_end * 1000) : null;
  await syncSubscriptionFromStripe(userId, {
    // Only overwrite `plan` when the price maps to a known tier - an
    // unrecognized price (e.g. STRIPE_BASIC_PRICE_ID misconfigured, or a
    // manually-created test Price we don't know about) shouldn't silently
    // downgrade someone's stored plan; it should just leave it as whatever
    // it already was and rely on `status` to reflect reality.
    plan: tier ?? undefined,
    status: subscription.status,
    stripePriceId: priceId,
    currentPeriodEnd,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
    stripeSubscriptionId: subscription.id,
  });
}

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    console.error("[stripe-webhook] missing signature header or STRIPE_WEBHOOK_SECRET");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 400 });
  }

  // Raw bytes, not parsed JSON - signature verification is computed over the
  // exact request body Stripe sent; re-serializing a parsed object would not
  // reproduce the same bytes and would always fail verification.
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid signature";
    console.error("[stripe-webhook] signature verification failed:", message);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (!HANDLED_TYPES.has(event.type)) {
    return NextResponse.json({ received: true, handled: false });
  }

  // Idempotency: atomically claim this event id before doing anything else.
  // If it's already been processed (redelivery, or Stripe's own "at least
  // once" guarantee sending the same event twice), skip straight to 200
  // without touching subscription state a second time.
  const isNew = await markWebhookEventProcessed(event.id, event.type);
  if (!isNew) {
    console.log("[stripe-webhook] duplicate event, already processed:", event.id, event.type);
    return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id;
        const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;

        if (!userId || !subscriptionId || !customerId) {
          console.error("[stripe-webhook] checkout.session.completed missing userId/subscriptionId/customerId", {
            userId,
            subscriptionId,
            customerId,
          });
          break;
        }

        await setStripeCustomerId(userId, customerId);
        const stripe = getStripe();
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        await syncFromSubscriptionObject(userId, subscription);
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
        const userId = resolveUserId(subscription) ?? (await findUserIdByStripeCustomerId(customerId));

        if (!userId) {
          console.error("[stripe-webhook] could not resolve userId for subscription event", {
            type: event.type,
            subscriptionId: subscription.id,
            customerId,
          });
          break;
        }

        await syncFromSubscriptionObject(userId, subscription);
        break;
      }

      case "invoice.payment_failed": {
        // Deliberately not touched here - a single failed invoice is not a
        // confirmed loss of access (Stripe is typically still retrying, and
        // the subscription's real status is "past_due" at this point, not
        // "canceled"/"unpaid"). The subscription's actual status transition
        // arrives as its own customer.subscription.updated event, which is
        // handled above - that's the single source of truth for status
        // changes, so duplicating the logic here would just risk the two
        // handlers disagreeing. This case exists only so the event is
        // acknowledged (and logged) rather than falling through as
        // "unhandled".
        const invoice = event.data.object as Stripe.Invoice;
        console.log("[stripe-webhook] invoice.payment_failed (no entitlement change):", invoice.id, invoice.customer);
        break;
      }
    }
  } catch (err) {
    // The event is already marked processed (claimed above) even though
    // handling it threw - re-processing on Stripe's automatic retry would
    // hit the same error again, and this logs loudly enough to be caught
    // and fixed manually rather than silently corrupting state via a partial
    // retry. Deliberate tradeoff: idempotency (never double-apply) over
    // automatic retry-until-success for this specific failure mode.
    console.error("[stripe-webhook] handler error for", event.type, event.id, err);
    return NextResponse.json({ error: "Handler error, event recorded but not applied" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
