import { prisma } from "@/lib/prisma";
import type { PickOddsSource } from "@/lib/odds-source";
import { Prisma, type BetType, type Period, type PickedSide, type PropMarket } from "@prisma/client";
import {
  FREE_PICK_LIMIT,
  isEntitledToPaidTier,
  resolveEffectiveTier,
  hasFeature,
  type Tier,
  type FeatureKey,
  type SubscriptionState,
} from "@/lib/entitlements";
import { pickCategory, PICK_CATEGORY_VERSION } from "@/server/data/stats";

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
  pickedSide?: PickedSide | null;
  mlFavoredSide?: PickedSide | null;
  // Only ever set by bulkImportPicksAction for a newly-created PLAYER_PROP
  // row (see parsePlayerProp) - every other caller (createPick, the manual
  // pick form) omits both, leaving them at their column default of null.
  // Never backfilled onto an existing row.
  playerName?: string;
  propMarket?: PropMarket;
  // Only ever set by bulkImportPicksAction, and only when resolution actually
  // used a doubleheader game number to pick this pick's game (see
  // resolveGameAndOdds' resolvedGameNumber). Omitted (column default null)
  // for every other caller and every non-doubleheader pick.
  gameNumber?: number | null;
  // Where `odds` came from (lib/odds-source.ts). Set by bulkImportPicksAction
  // and createPick; a caller that omits it leaves the column null (unknown).
  oddsSource?: PickOddsSource | null;
};

// Explicit interactive-transaction bounds for the entitlement + insert transaction
// (Prisma's defaults are maxWait 2 s / timeout 5 s).
//  - timeout 15 s: the transaction is now ~4 statements (row lock, count, sport
//    lookup, ONE batch insert). A 1,000-row batch measures ~0.13 s against a
//    local database (bulk-import-batch-insert-acceptance-test.ts); production
//    adds a few network round trips, so ~1-2 s is the expected ceiling at 1,000
//    rows and less at the 500-row import cap (import-limits.ts). 15 s is 7x+
//    headroom over that, and still short enough that a wedged transaction does
//    not hold the user's subscription row lock - or one of the instance's few
//    pooled connections (connection_limit on DATABASE_URL, see
//    docs/c4-grading-throughput.md section 7) - for long. The old per-row inserts
//    took N round trips inside the default 5 s and could not finish a large import.
//  - maxWait 10 s: the per-instance pool is small, so a transaction can wait for
//    a connection while other work on the instance finishes; the 2 s default is
//    shorter than the pool's own wait (pool_timeout).
const ENTITLEMENT_TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 };

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
  return insertPicksWithEntitlementCheck(userId, rows.length, async () => rows);
}

// The same gate + insert, for a caller whose rows are not final until it has
// written something else they depend on. `buildRows` runs INSIDE the
// transaction, after the row lock and the pick-limit check have passed, on the
// transaction's own client - so whatever it creates (the bulk import's new
// cappers and sports, see import-refs.ts) commits with the picks or rolls back
// with them, and is never created at all for an import the limit refuses.
// `rowCount` is what the limit is checked against; buildRows must return
// exactly that many rows. Everything buildRows does must go through `tx`.
export async function insertPicksWithEntitlementCheck(
  userId: string,
  rowCount: number,
  buildRows: (tx: Prisma.TransactionClient) => Promise<PickInsertData[]>
): Promise<AtomicCreateResult> {
  if (rowCount === 0) return { allowed: true, created: [] };

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ plan: string; status: string; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean }[]>`
      SELECT "plan", "status", "currentPeriodEnd", "cancelAtPeriodEnd" FROM "subscriptions" WHERE "userId" = ${userId} FOR UPDATE
    `;
    const tier = resolveEffectiveTier(toSubscriptionState(locked[0] ?? null));

    if (tier === "FREE") {
      const pickCount = await tx.pick.count({ where: { userId } });
      if (pickCount + rowCount > FREE_PICK_LIMIT) {
        const remaining = Math.max(0, FREE_PICK_LIMIT - pickCount);
        return {
          allowed: false,
          tier,
          pickCount,
          limit: FREE_PICK_LIMIT,
          remaining,
          message:
            rowCount === 1
              ? "Free plan is limited to " + FREE_PICK_LIMIT + " tracked picks. Upgrade to Basic for unlimited tracking."
              : "This would add " +
                rowCount +
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

    const rows = await buildRows(tx);
    if (rows.length !== rowCount) {
      throw new Error("insertPicksWithEntitlementCheck: buildRows returned " + rows.length + " rows, expected " + rowCount);
    }

    // Every pick is stamped with its pickCategory here, once, at insert - this
    // is the only place a Pick row is created (createPick and bulk import both
    // land here), and nothing afterwards changes a category input (grading only
    // touches status/gradedAt/gradedViaFuzzyMatch), so the stored value stays
    // exact. Lets the /cappers aggregates GROUP BY category in SQL instead of
    // re-deriving it per pick in JS (see capper-list-aggregates.ts). One sport
    // lookup per batch, inside the same transaction.
    const sports = await tx.sport.findMany({
      where: { id: { in: Array.from(new Set(rows.map((r) => r.sportId))) } },
      select: { id: true, name: true },
    });
    const sportNameById = new Map(sports.map((s) => [s.id, s.name]));

    // A sportId with no matching sport can't be stamped (and the insert below
    // will fail its foreign key anyway) - leave it at the unstamped default
    // rather than guess a sport for the category.
    const stamp = (row: PickInsertData) => {
      const sportName = sportNameById.get(row.sportId);
      return sportName
        ? {
            category: pickCategory({
              betType: row.betType,
              period: row.period ?? "FULL_GAME",
              betDetail: row.betDetail ?? null,
              odds: row.odds,
              line: row.line ?? null,
              sportName,
              pickedSide: row.pickedSide ?? null,
              mlFavoredSide: row.mlFavoredSide ?? null,
              propMarket: row.propMarket ?? null,
            }),
            categoryVersion: PICK_CATEGORY_VERSION,
          }
        : {};
    };
    // ONE INSERT ... RETURNING for the whole batch (Prisma >= 5.14), instead of
    // one statement per row. The per-row version issued N statements through the
    // transaction's one connection (a transaction always runs on a single
    // connection, whatever connection_limit is), so a
    // large import held the subscription row lock for N round trips and could
    // outlive Prisma's default 5 s interactive-transaction timeout. Rows come
    // back in input order. The stamp is still spread into every row.
    const created = await tx.pick.createManyAndReturn({
      data: rows.map((row) => ({ ...row, userId, status: "PENDING" as const, ...stamp(row) })),
      select: { id: true },
    });
    return { allowed: true, created };
  }, ENTITLEMENT_TX_OPTIONS);
}

// --- Stripe-facing helpers (used by the webhook handler and checkout action) ---

// `db` defaults to the shared client but accepts an interactive-transaction
// client so the Stripe webhook handler can run this read/write inside the
// same transaction that claims the event id (see stripe-webhook.ts). A call to
// the bare `prisma` singleton from inside a `$transaction` callback runs on a
// different connection: it is outside the transaction (not rolled back with it),
// and when the per-instance pool is exhausted (always, at connection_limit=1) it
// deadlocks waiting for a connection the transaction holds - so every DB call
// the webhook makes mid-transaction must be threaded through `tx`, not just the
// writes.
type SubscriptionDb = Prisma.TransactionClient | typeof prisma;

export async function findUserIdByStripeCustomerId(
  customerId: string,
  db: SubscriptionDb = prisma
): Promise<string | null> {
  const sub = await db.subscription.findFirst({ where: { stripeCustomerId: customerId }, select: { userId: true } });
  return sub?.userId ?? null;
}

export async function setStripeCustomerId(userId: string, stripeCustomerId: string, db: SubscriptionDb = prisma) {
  await db.subscription.update({ where: { userId }, data: { stripeCustomerId } });
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

// Idempotent by construction (an update on userId, always writing Stripe's
// current field values, never incrementing/toggling anything) - applying the
// same webhook payload twice leaves the row identical both times. The webhook
// handler additionally claims the event id in the SAME transaction as this
// write (see applyStripeWebhookEvent in stripe-webhook.ts), so a committed
// stripe_webhook_events row and its subscription mutation always agree:
// duplicate delivery is a no-op, and a transient failure rolls back both.
export async function syncSubscriptionFromStripe(
  userId: string,
  data: StripeSubscriptionSync,
  db: SubscriptionDb = prisma
) {
  await db.subscription.update({
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
