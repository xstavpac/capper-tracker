import Stripe from "stripe";
import type { Tier } from "@/lib/entitlements";

// Lazily constructed, not a module-level singleton built at import time -
// STRIPE_SECRET_KEY won't exist in every environment this file gets
// imported into (e.g. a build step, or before the env var is configured),
// and Stripe's constructor throws synchronously on a missing/malformed key.
// Building it on first real use means every OTHER route in the app keeps
// working even before Stripe is configured; only billing routes fail, with
// a clear error, when actually hit.
let stripeClient: Stripe | null = null;

export function getStripe(): Stripe {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error(
        "STRIPE_SECRET_KEY is not set. Add your Stripe TEST MODE secret key (starts with sk_test_) to .env.local."
      );
    }
    stripeClient = new Stripe(key, { apiVersion: "2026-07-29.dahlia" });
  }
  return stripeClient;
}

// Only BASIC is actually purchasable right now (see PRO_PRICE_ID below) -
// this map exists so a webhook payload's price id can be translated back to
// our internal Tier without a second hardcoded lookup anywhere else.
export function priceIdToTier(priceId: string | null | undefined): Tier | null {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_BASIC_PRICE_ID) return "BASIC";
  if (priceId === process.env.STRIPE_PRO_PRICE_ID) return "PRO";
  return null;
}

export function tierToPriceId(tier: "BASIC" | "PRO"): string {
  const id = tier === "BASIC" ? process.env.STRIPE_BASIC_PRICE_ID : process.env.STRIPE_PRO_PRICE_ID;
  if (!id) {
    throw new Error(
      (tier === "BASIC" ? "STRIPE_BASIC_PRICE_ID" : "STRIPE_PRO_PRICE_ID") +
        " is not set - create a recurring Price in Stripe test mode and add its id to .env.local."
    );
  }
  return id;
}
