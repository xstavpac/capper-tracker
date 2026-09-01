import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { applyStripeWebhookEvent } from "@/server/data/stripe-webhook";

export const dynamic = "force-dynamic";

// Verify the Stripe signature, then hand the event to applyStripeWebhookEvent,
// which claims the event id and applies its subscription mutation in one
// transaction (see docs/m7-stripe-webhook-idempotency.md). This route only
// maps the outcome to an HTTP status:
//   - applied / duplicate / ignored -> 200 (state is consistent either way)
//   - a thrown error -> 500. The transaction, including the dedupe-claim row,
//     has rolled back, so Stripe's retry reprocesses the event cleanly. This
//     is the opposite of the old behavior, where the claim was recorded before
//     the handler ran and a mid-handler failure was permanent.
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

  try {
    const result = await applyStripeWebhookEvent(event);
    return NextResponse.json({ received: true, ...result });
  } catch (err) {
    // One structured line per failure so stranded events are greppable in
    // Vercel runtime logs even though the transaction rolled the claim row
    // back. Stripe will retry (up to three days, exponential backoff).
    console.error(
      JSON.stringify({
        tag: "stripe-webhook-failed",
        eventId: event.id,
        type: event.type,
        message: err instanceof Error ? err.message : String(err),
      })
    );
    return NextResponse.json({ error: "Handler error, nothing recorded - Stripe will retry" }, { status: 500 });
  }
}
