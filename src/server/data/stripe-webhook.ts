import type Stripe from "stripe";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getStripe, priceIdToTier } from "@/lib/stripe";
import {
  findUserIdByStripeCustomerId,
  setStripeCustomerId,
  syncSubscriptionFromStripe,
} from "@/server/data/subscriptions";

// M7 fix (see docs/m7-stripe-webhook-idempotency.md). The webhook used to
// record the event id as processed BEFORE running the handler, non-atomically.
// A transient DB failure mid-handler then left the event marked processed with
// its subscription mutation never applied - and Stripe's retry hit the dedupe
// skip and 200'd without repairing it, silently stranding the user on the
// wrong plan.
//
// This module claims the event id and applies every subscription write inside
// ONE interactive transaction:
//   - handler throws  -> the whole transaction rolls back, INCLUDING the
//     stripe_webhook_events claim row, so Stripe's retry reprocesses cleanly.
//   - duplicate delivery -> the claim INSERT hits the primary-key constraint
//     (P2002); the transaction rolls back and we report "duplicate" (a no-op,
//     the earlier delivery already applied it).
//   - concurrent duplicate deliveries -> the second transaction's claim INSERT
//     blocks on the first's uncommitted unique key, then either P2002s (first
//     committed) or succeeds (first rolled back). Exactly one mutation lands.
//
// A committed stripe_webhook_events row and its subscription mutation now
// always agree. Exactly-once is preserved; a transient failure can no longer
// permanently lose a subscription update.

// Every event type this endpoint acts on. Anything else gets a 200 with no
// effect (Stripe expects 2xx for any event sent to a registered endpoint;
// a non-2xx would make Stripe retry an unhandled type for three days).
const HANDLED_TYPES = new Set<string>([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
]);

export type ApplyWebhookResult =
  | { status: "applied" } // handled type, transaction committed (mutation applied, or intentionally a no-op)
  | { status: "duplicate" } // event id already recorded by an earlier delivery; nothing re-applied
  | { status: "ignored" }; // event type this endpoint does not act on

export type ApplyWebhookDeps = {
  // Injectable so tests can assert this external call happens BEFORE the
  // transaction opens. Defaults to the real Stripe client.
  retrieveSubscription?: (subscriptionId: string) => Promise<Stripe.Subscription>;
};

type CheckoutContext = { userId: string; customerId: string; subscription: Stripe.Subscription };

function resolveUserId(subscription: Stripe.Subscription): string | null {
  return (subscription.metadata?.userId as string | undefined) ?? null;
}

async function syncFromSubscriptionObject(
  tx: Prisma.TransactionClient,
  userId: string,
  subscription: Stripe.Subscription
) {
  const item = subscription.items.data[0];
  const priceId = item?.price?.id ?? null;
  const tier = priceIdToTier(priceId);
  // current_period_end lives on the subscription item, not the subscription
  // itself, as of this SDK/API version - a subscription can in principle have
  // multiple items with different periods, though this app only ever creates
  // single-item subscriptions.
  const currentPeriodEnd = item?.current_period_end ? new Date(item.current_period_end * 1000) : null;
  await syncSubscriptionFromStripe(
    userId,
    {
      // Only overwrite `plan` when the price maps to a known tier - an
      // unrecognized price shouldn't silently downgrade a real paying
      // customer; leave `plan` as-is and rely on `status` to reflect reality.
      plan: tier ?? undefined,
      status: subscription.status,
      stripePriceId: priceId,
      currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
      stripeSubscriptionId: subscription.id,
    },
    tx
  );
}

async function dispatchWebhookEvent(
  tx: Prisma.TransactionClient,
  event: Stripe.Event,
  checkoutContext: CheckoutContext | null
) {
  switch (event.type) {
    case "checkout.session.completed": {
      // Malformed session (missing userId/subscriptionId/customerId) - already
      // logged in applyStripeWebhookEvent. Fall through to commit the claim
      // row anyway so Stripe stops retrying a permanently-malformed session.
      if (!checkoutContext) break;
      await setStripeCustomerId(checkoutContext.userId, checkoutContext.customerId, tx);
      await syncFromSubscriptionObject(tx, checkoutContext.userId, checkoutContext.subscription);
      break;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId =
        typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
      const userId = resolveUserId(subscription) ?? (await findUserIdByStripeCustomerId(customerId, tx));

      if (!userId) {
        // Can't map this to one of our users. Commit the claim row (so it's
        // acknowledged and not retried forever) but apply no mutation - same
        // behavior as before the M7 fix.
        console.error("[stripe-webhook] could not resolve userId for subscription event", {
          type: event.type,
          subscriptionId: subscription.id,
          customerId,
        });
        break;
      }

      await syncFromSubscriptionObject(tx, userId, subscription);
      break;
    }

    case "invoice.payment_failed": {
      // Deliberately no entitlement change - a single failed invoice is not a
      // confirmed loss of access (Stripe is typically still retrying; the
      // real status transition arrives as its own customer.subscription.updated
      // event, handled above). This case exists only so the event is
      // acknowledged and logged rather than treated as unhandled.
      const invoice = event.data.object as Stripe.Invoice;
      console.log("[stripe-webhook] invoice.payment_failed (no entitlement change):", invoice.id, invoice.customer);
      break;
    }
  }
}

// Claims `event.id` and applies its subscription mutation atomically. Throws
// on a transient DB failure (the caller maps that to HTTP 500 so Stripe
// retries); never throws for a duplicate delivery.
export async function applyStripeWebhookEvent(
  event: Stripe.Event,
  deps: ApplyWebhookDeps = {}
): Promise<ApplyWebhookResult> {
  if (!HANDLED_TYPES.has(event.type)) return { status: "ignored" };

  // Resolve any external Stripe API call OUTSIDE the transaction - never hold
  // a DB transaction open across a network round-trip. checkout.session.completed
  // is the only handled type whose event payload is not already a Subscription
  // object; it carries a Checkout Session, so we fetch the Subscription here.
  let checkoutContext: CheckoutContext | null = null;
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.client_reference_id;
    const subscriptionId =
      typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
    const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;

    if (!userId || !subscriptionId || !customerId) {
      console.error("[stripe-webhook] checkout.session.completed missing userId/subscriptionId/customerId", {
        userId,
        subscriptionId,
        customerId,
      });
      // checkoutContext stays null; dispatch records the claim and applies nothing.
    } else {
      const retrieveSubscription =
        deps.retrieveSubscription ?? ((id: string) => getStripe().subscriptions.retrieve(id));
      const subscription = await retrieveSubscription(subscriptionId);
      checkoutContext = { userId, customerId, subscription };
    }
  }

  try {
    await prisma.$transaction(
      async (tx) => {
        // The claim is the FIRST statement in the transaction, so a P2002
        // caught below can only be the stripe_webhook_events primary key.
        await tx.stripeWebhookEvent.create({ data: { id: event.id, type: event.type } });
        await dispatchWebhookEvent(tx, event, checkoutContext);
      },
      { timeout: 10_000, maxWait: 5_000 }
    );
    return { status: "applied" };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Already recorded by an earlier delivery. The whole transaction rolled
      // back; nothing was double-applied.
      return { status: "duplicate" };
    }
    // Transient failure. The transaction - including the claim row - rolled
    // back. Rethrow: the route returns 500 and Stripe's retry reprocesses.
    throw err;
  }
}
