import { prisma } from "@/lib/prisma";
import { Prisma, type BetType, type Period } from "@prisma/client";
import {
  FREE_PICK_LIMIT,
  isEntitledToPaidTier,
  resolveEffectiveTier,
  hasFeature,
  type Tier,
  type FeatureKey,
  type SubscriptionState,
} from "@/lib/entitlements";

function toSubscriptionState(
  sub: { plan: string; status: string; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean } | null
): SubscriptionState {
  if (!sub) return null;
  return { plan: sub.plan as Tier, status: sub.status, currentPeriodEnd: sub.currentPeriodEnd, cancelAtPeriodEnd: sub.cancelAtPeriodEnd };
}

export async function getSubscriptionForUser(userId: string) {
  return prisma.subscription.findUnique({ where: { userId } });
}

export type Entitlements = {
  tier: Tier;
  planOnFile: Tier; // what they last paid for, even if currently not entitled (e.g. lapsed)
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  hasFeature: (feature: FeatureKey) => boolean;
};

// The one function pages/components should call to find out what a user can
// see/do - never read Subscription.plan directly for an access decision,
// always go through here (or canTrackPick below for the pick-count case
// specifically) so there's exactly one place the Stripe-status-to-access
// translation lives.
export async function getEntitlementsForUser(userId: string): Promise<Entitlements> {
  const sub = await getSubscriptionForUser(userId);
  const state = toSubscriptionState(sub);
  const tier = resolveEffectiveTier(state);
  return {
    tier,
    planOnFile: (sub?.plan as Tier) ?? "FREE",
    status: sub?.status ?? "active",
    cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
    currentPeriodEnd: sub?.currentPeriodEnd ?? null,
    hasFeature: (feature) => hasFeature(tier, feature),
  };
}

export type CanTrackPickResult =
  | { allowed: true; tier: Tier }
  | { allowed: false; tier: Tier; pickCount: number; limit: number; remaining: number; message: string };

// Read-only / advisory check - for rendering an upgrade prompt or a "997 of
// 1000 used" indicator. NOT the authorization gate for an actual write; that
// needs the row-locked version below, since this one does two unlocked reads
// (subscription, then count) that a concurrent request could race between.
// `additionalPicks` generalizes the single-pick case (default 1) to "would
// importing N more picks fit" for a bulk-import preview.
export async function canTrackPick(userId: string, additionalPicks = 1): Promise<CanTrackPickResult> {
  const sub = await getSubscriptionForUser(userId);
  const tier = resolveEffectiveTier(toSubscriptionState(sub));
  if (tier !== "FREE") return { allowed: true, tier };

  const pickCount = await prisma.pick.count({ where: { userId } });
  if (pickCount + additionalPicks > FREE_PICK_LIMIT) {
    return {
      allowed: false,
      tier,
      pickCount,
      limit: FREE_PICK_LIMIT,
      remaining: Math.max(0, FREE_PICK_LIMIT - pickCount),
      message:
        "Free plan is limited to " +
        FREE_PICK_LIMIT +
        " tracked picks. You have " +
        pickCount +
        " and " +
        Math.max(0, FREE_PICK_LIMIT - pickCount) +
        " slot" +
        (Math.max(0, FREE_PICK_LIMIT - pickCount) === 1 ? "" : "s") +
        " left - upgrade to Basic for unlimited tracking.",
    };
  }
  return { allowed: true, tier };
}

export type PickInsertData = {
  capperId: string;
  sportId: string;
  leagueId?: string;
  homeTeam: string;
  awayTeam: string;
  betType: BetType;
  betDetail?: string;
  odds: number;
  line?: number | null;
  period?: Period;
  sportsbook?: string;
  units: number;
  gameTime: Date;
  notes?: string;
};

export type AtomicCreateResult =
  | { allowed: true; created: { id: string }[] }
  | { allowed: false; tier: Tier; pickCount: number; limit: number; remaining: number; message: string };

// The real authorization gate. Locks this user's Subscription row (SELECT
// ... FOR UPDATE) for the duration of one transaction, so two concurrent
// requests for the SAME user serialize here - the second can't read the
// count until the first's transaction (lock + count + insert) has fully
// committed, which is what actually prevents a Free user from ending up
// over FREE_PICK_LIMIT via a race. Used by both the single-pick path and
// the bulk-import path (see createPicksAction/bulkImportPicksAction) - bulk
// passes every row to insert in one call, so the whole batch is checked
// against the limit and inserted in one all-or-nothing transaction, never
// partially.
//
// Every user has exactly one Subscription row from first sign-in (see
// upsertUserFromSupabase) - `FOR UPDATE` on a query that (correctly) matches
// zero rows just acquires no lock, so a hypothetically-missing row fails
// open into "count is unlocked" rather than throwing; that's an accepted,
// theoretical edge case (it would mean the user-creation invariant was
// violated elsewhere), not a case this function tries to paper over.
export async function createPicksWithEntitlementCheck(userId: string, rows: PickInsertData[]): Promise<AtomicCreateResult> {
  if (rows.length === 0) return { allowed: true, created: [] };

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ plan: string; status: string; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean }[]>`
      SELECT "plan", "status", "currentPeriodEnd", "cancelAtPeriodEnd" FROM "subscriptions" WHERE "userId" = ${userId} FOR UPDATE
    `;
    const tier = resolveEffectiveTier(toSubscriptionState(locked[0] ?? null));

    if (tier === "FREE") {
      const pickCount = await tx.pick.count({ where: { userId } });
      if (pickCount + rows.length > FREE_PICK_LIMIT) {
        const remaining = Math.max(0, FREE_PICK_LIMIT - pickCount);
        return {
          allowed: false,
          tier,
          pickCount,
          limit: FREE_PICK_LIMIT,
          remaining,
          message:
            rows.length === 1
              ? "Free plan is limited to " + FREE_PICK_LIMIT + " tracked picks. Upgrade to Basic for unlimited tracking."
              : "This would add " +
                rows.length +
                " picks, but your Free plan only has " +
                remaining +
                " slot" +
                (remaining === 1 ? "" : "s") +
                " left (" +
                pickCount +
                "/" +
                FREE_PICK_LIMIT +
                " used). Nothing was imported - upgrade to Basic for unlimited tracking, or import " +
                remaining +
                " or fewer picks.",
        };
      }
    }

    const created = await Promise.all(
      rows.map((row) => tx.pick.create({ data: { ...row, userId, status: "PENDING" }, select: { id: true } }))
    );
    return { allowed: true, created };
  });
}

// --- Stripe-facing helpers (used by the webhook handler and checkout action) ---

export async function findUserIdByStripeCustomerId(customerId: string): Promise<string | null> {
  const sub = await prisma.subscription.findFirst({ where: { stripeCustomerId: customerId }, select: { userId: true } });
  return sub?.userId ?? null;
}

export async function setStripeCustomerId(userId: string, stripeCustomerId: string) {
  await prisma.subscription.update({ where: { userId }, data: { stripeCustomerId } });
}

export type StripeSubscriptionSync = {
  // undefined (not "FREE") when the webhook couldn't map the Stripe price id
  // to a known tier - Prisma's update omits an undefined field from the SQL
  // SET clause entirely, leaving the existing plan untouched rather than
  // forcing a real paying customer to FREE because of a price-id
  // misconfiguration. Every other field still gets written for real, so
  // status/currentPeriodEnd/etc stay accurate even in that case.
  plan: Tier | undefined;
  status: string;
  stripePriceId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
};

// Idempotent by construction (an upsert on userId, always writing Stripe's
// current field values, never incrementing/toggling anything) - applying the
// same webhook payload twice leaves the row identical both times. Combined
// with the StripeWebhookEvent dedupe table (checked before this is ever
// called), duplicate delivery of the same event is a non-issue twice over.
export async function syncSubscriptionFromStripe(userId: string, data: StripeSubscriptionSync) {
  await prisma.subscription.update({
    where: { userId },
    data: {
      plan: data.plan,
      status: data.status,
      stripePriceId: data.stripePriceId,
      currentPeriodEnd: data.currentPeriodEnd,
      cancelAtPeriodEnd: data.cancelAtPeriodEnd,
      stripeCustomerId: data.stripeCustomerId,
      stripeSubscriptionId: data.stripeSubscriptionId,
    },
  });
}

// Records a Stripe event id as processed, atomically - relies on the
// unique-constraint violation from a duplicate insert to signal "already
// handled" rather than a separate check-then-insert (which would itself be
// racy under concurrent delivery of the same event). Returns false if this
// event was already processed (caller should skip handling it).
export async function markWebhookEventProcessed(eventId: string, type: string): Promise<boolean> {
  try {
    await prisma.stripeWebhookEvent.create({ data: { id: eventId, type } });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return false; // already processed - duplicate delivery
    }
    throw err;
  }
}
