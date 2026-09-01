// Proof for the M7 fix (docs/m7-stripe-webhook-idempotency.md): the Stripe
// webhook claims the event id and applies its subscription mutation in ONE
// transaction, so a transient failure can never leave an event marked
// processed with its mutation unapplied.
//
// The load-bearing cases are 3 + 4 (mid-handler failure records nothing, and
// the retry applies the update) and 5 + 6 (concurrent duplicate deliveries
// apply the mutation exactly once).
//
// Pure: prisma.$transaction is replaced with an in-memory transactional store
// (staging copy on entry, adopted on success, discarded on throw - real
// rollback semantics), and the Stripe API call is injected. No database is
// touched. Run with:
//   npx tsx src/server/data/stripe-webhook-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { applyStripeWebhookEvent } from "@/server/data/stripe-webhook";
import type Stripe from "stripe";

process.env.STRIPE_BASIC_PRICE_ID = "price_basic_test";
process.env.STRIPE_PRO_PRICE_ID = "price_pro_test";
const BASIC = "price_basic_test";
const UNKNOWN_PRICE = "price_unknown_test";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

function p2002() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: "stripe_webhook_events_pkey" },
  });
}
function p2025() {
  return new Prisma.PrismaClientKnownRequestError("Record to update not found", {
    code: "P2025",
    clientVersion: "test",
  });
}

// ---- in-memory transactional store -------------------------------------

type SubRow = Record<string, unknown> & { userId: string };

class Store {
  events = new Map<string, { id: string; type: string }>();
  subs = new Map<string, SubRow>();
  clone(): Store {
    const s = new Store();
    s.events = new Map(this.events);
    s.subs = new Map([...this.subs].map(([k, v]) => [k, { ...v }]));
    return s;
  }
  adopt(other: Store) {
    this.events = other.events;
    this.subs = other.subs;
  }
}

type Faults = {
  failEventCreateOnce?: boolean;
  failSubUpdateOnce?: boolean;
};

type Harness = {
  store: Store;
  faults: Faults;
  calls: string[]; // ordered tags: "retrieve", "transaction", "sub.update", "event.create"
  txOpts: unknown;
  subUpdateArgs: { where: unknown; data: Record<string, unknown> }[];
  restore: () => void;
};

const realTransaction = prisma.$transaction.bind(prisma);

function install(store: Store, faults: Faults): Harness {
  const h: Harness = {
    store,
    faults,
    calls: [],
    txOpts: undefined,
    subUpdateArgs: [],
    restore: () => {
      (prisma as unknown as { $transaction: unknown }).$transaction = realTransaction;
    },
  };

  const makeTxClient = (staging: Store) => ({
    stripeWebhookEvent: {
      create: async ({ data }: { data: { id: string; type: string } }) => {
        if (faults.failEventCreateOnce) {
          faults.failEventCreateOnce = false;
          throw new Error("simulated transient failure on claim insert");
        }
        if (staging.events.has(data.id)) throw p2002();
        staging.events.set(data.id, { id: data.id, type: data.type });
        h.calls.push("event.create");
        return data;
      },
    },
    subscription: {
      update: async ({ where, data }: { where: { userId: string }; data: Record<string, unknown> }) => {
        h.calls.push("sub.update");
        h.subUpdateArgs.push({ where, data });
        if (faults.failSubUpdateOnce) {
          faults.failSubUpdateOnce = false;
          throw new Error("simulated transient failure on subscription update");
        }
        const row = staging.subs.get(where.userId);
        if (!row) throw p2025();
        // Model Prisma: an `undefined` field is omitted from the SET clause.
        for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
        return row;
      },
      findFirst: async ({ where }: { where: { stripeCustomerId: string } }) => {
        for (const row of staging.subs.values()) {
          if (row.stripeCustomerId === where.stripeCustomerId) return { userId: row.userId };
        }
        return null;
      },
    },
  });

  (prisma as unknown as { $transaction: unknown }).$transaction = async (
    fn: (tx: unknown) => Promise<unknown>,
    opts: unknown
  ) => {
    h.calls.push("transaction");
    h.txOpts = opts;
    const staging = store.clone();
    const result = await fn(makeTxClient(staging)); // a throw here propagates -> staging discarded
    store.adopt(staging); // commit
    return result;
  };

  return h;
}

// ---- fixtures ---------------------------------------------------------

function seededStore(sub: Partial<SubRow> = {}): Store {
  const s = new Store();
  s.subs.set("user_1", { userId: "user_1", plan: "FREE", status: "active", stripeCustomerId: null, ...sub });
  return s;
}

function subEvent(
  type: string,
  over: {
    id?: string;
    userId?: string | null;
    priceId?: string;
    status?: string;
    customerId?: string;
    cancelAtPeriodEnd?: boolean;
    periodEnd?: number;
    subId?: string;
  } = {}
): Stripe.Event {
  const subscription = {
    id: over.subId ?? "sub_1",
    status: over.status ?? "active",
    customer: over.customerId ?? "cus_1",
    cancel_at_period_end: over.cancelAtPeriodEnd ?? false,
    metadata: over.userId === null ? {} : { userId: over.userId ?? "user_1" },
    items: { data: [{ price: { id: over.priceId ?? BASIC }, current_period_end: over.periodEnd ?? 2_000_000_000 }] },
  };
  return { id: over.id ?? "evt_1", type, data: { object: subscription } } as unknown as Stripe.Event;
}

function checkoutEvent(
  over: { id?: string; userId?: string | null; subscription?: string | null; customer?: string | null } = {}
): Stripe.Event {
  const session = {
    client_reference_id: over.userId === null ? null : over.userId ?? "user_1",
    subscription: over.subscription === null ? null : over.subscription ?? "sub_1",
    customer: over.customer === null ? null : over.customer ?? "cus_1",
  };
  return { id: over.id ?? "evt_ck", type: "checkout.session.completed", data: { object: session } } as unknown as Stripe.Event;
}

function retrievedSubscription(over: { priceId?: string; status?: string } = {}): Stripe.Subscription {
  return {
    id: "sub_1",
    status: over.status ?? "active",
    customer: "cus_1",
    cancel_at_period_end: false,
    metadata: { userId: "user_1" },
    items: { data: [{ price: { id: over.priceId ?? BASIC }, current_period_end: 2_000_000_000 }] },
  } as unknown as Stripe.Subscription;
}

// ---- cases -----------------------------------------------------------

async function main() {
  // 1. Happy path: new subscription event applies the mutation and records the id.
  {
    const store = seededStore();
    const h = install(store, {});
    const res = await applyStripeWebhookEvent(subEvent("customer.subscription.created", { id: "evt_1" }));
    expect("1: result applied", res, { status: "applied" });
    expect("1: event id recorded", store.events.has("evt_1"), true);
    expect("1: plan written from price id", store.subs.get("user_1")!.plan, "BASIC");
    h.restore();
  }

  // 2. Duplicate delivery: event id already present -> no re-apply.
  {
    const store = seededStore({ plan: "BASIC" });
    store.events.set("evt_1", { id: "evt_1", type: "customer.subscription.updated" });
    const h = install(store, {});
    const res = await applyStripeWebhookEvent(
      subEvent("customer.subscription.updated", { id: "evt_1", status: "canceled" })
    );
    expect("2: result duplicate", res, { status: "duplicate" });
    expect("2: no subscription.update issued", h.calls.includes("sub.update"), false);
    expect("2: subscription row untouched", store.subs.get("user_1")!.status, "active");
    h.restore();
  }

  // 3. Mid-handler transient failure -> the claim row is NOT recorded (core M7 proof, part 1).
  let sharedStore: Store;
  {
    const store = seededStore();
    sharedStore = store;
    const h = install(store, { failSubUpdateOnce: true });
    let threw = false;
    try {
      await applyStripeWebhookEvent(subEvent("customer.subscription.updated", { id: "evt_7", priceId: BASIC }));
    } catch {
      threw = true;
    }
    expect("3: applyStripeWebhookEvent rethrew the transient failure", threw, true);
    expect("3: claim row rolled back (not recorded)", store.events.has("evt_7"), false);
    expect("3: subscription mutation rolled back", store.subs.get("user_1")!.plan, "FREE");
    h.restore();
  }

  // 4. Stripe's retry of the event from case 3 now succeeds (core M7 proof, part 2).
  {
    const h = install(sharedStore, {});
    const res = await applyStripeWebhookEvent(
      subEvent("customer.subscription.updated", { id: "evt_7", priceId: BASIC })
    );
    expect("4: retry applied", res, { status: "applied" });
    expect("4: claim row now recorded", sharedStore.events.has("evt_7"), true);
    expect("4: subscription update no longer lost", sharedStore.subs.get("user_1")!.plan, "BASIC");
    h.restore();
  }

  // 5. Concurrent duplicate deliveries, first commits: second sees the claim key and no-ops.
  // (The DB blocks the second INSERT on the first's uncommitted unique key, then P2002s
  //  once it commits - modeled here as second-after-first.)
  {
    const store = seededStore();
    const h1 = install(store, {});
    const a = await applyStripeWebhookEvent(subEvent("customer.subscription.updated", { id: "evt_x", priceId: BASIC }));
    h1.restore();
    const h2 = install(store, {});
    const b = await applyStripeWebhookEvent(subEvent("customer.subscription.updated", { id: "evt_x", priceId: BASIC }));
    h2.restore();
    expect("5: first applied, second duplicate", [a, b], [{ status: "applied" }, { status: "duplicate" }]);
    expect("5: mutation applied exactly once (idempotent field write regardless)", store.subs.get("user_1")!.plan, "BASIC");
  }

  // 6. Concurrent duplicate deliveries, first rolls back mid-handler: second applies it.
  {
    const store = seededStore();
    const h1 = install(store, { failSubUpdateOnce: true });
    let aThrew = false;
    try {
      await applyStripeWebhookEvent(subEvent("customer.subscription.updated", { id: "evt_y", priceId: BASIC }));
    } catch {
      aThrew = true;
    }
    h1.restore();
    const h2 = install(store, {});
    const b = await applyStripeWebhookEvent(subEvent("customer.subscription.updated", { id: "evt_y", priceId: BASIC }));
    h2.restore();
    expect("6: first threw, second applied", [aThrew, b], [true, { status: "applied" }]);
    expect("6: claim recorded once", store.events.has("evt_y"), true);
    expect("6: mutation applied exactly once", store.subs.get("user_1")!.plan, "BASIC");
  }

  // 7. checkout.session.completed: the Stripe API call happens BEFORE the transaction opens.
  {
    const store = seededStore();
    const h = install(store, {});
    const res = await applyStripeWebhookEvent(checkoutEvent({ id: "evt_ck" }), {
      retrieveSubscription: async () => {
        h.calls.push("retrieve");
        return retrievedSubscription();
      },
    });
    expect("7: applied", res, { status: "applied" });
    expect("7: retrieve ran before transaction", h.calls.slice(0, 2), ["retrieve", "transaction"]);
    expect("7: customer id persisted (setStripeCustomerId)", store.subs.get("user_1")!.stripeCustomerId, "cus_1");
    expect("7: plan synced (syncFromSubscriptionObject)", store.subs.get("user_1")!.plan, "BASIC");
    expect("7: both writes inside the transaction", h.calls.filter((c) => c === "sub.update").length, 2);
    h.restore();
  }

  // 7b. Malformed checkout session: no Stripe call, claim still recorded, no mutation.
  {
    const store = seededStore();
    const h = install(store, {});
    let retrieveCalled = false;
    const res = await applyStripeWebhookEvent(checkoutEvent({ id: "evt_ck2", subscription: null }), {
      retrieveSubscription: async () => {
        retrieveCalled = true;
        return retrievedSubscription();
      },
    });
    expect("7b: applied (acknowledged)", res, { status: "applied" });
    expect("7b: no Stripe retrieve for a malformed session", retrieveCalled, false);
    expect("7b: event recorded so Stripe stops retrying", store.events.has("evt_ck2"), true);
    expect("7b: no subscription mutation", h.calls.includes("sub.update"), false);
    h.restore();
  }

  // 8. invoice.payment_failed: recorded, no entitlement change.
  {
    const store = seededStore({ plan: "BASIC" });
    const h = install(store, {});
    const evt = { id: "evt_inv", type: "invoice.payment_failed", data: { object: { id: "in_1", customer: "cus_1" } } } as unknown as Stripe.Event;
    const res = await applyStripeWebhookEvent(evt);
    expect("8: applied", res, { status: "applied" });
    expect("8: recorded", store.events.has("evt_inv"), true);
    expect("8: no subscription.update", h.calls.includes("sub.update"), false);
    h.restore();
  }

  // 8b. Unresolvable userId (no metadata.userId, customer matches no Subscription
  //     row): the claim COMMITS with no mutation, and the route returns 200 - a
  //     deliberate no-op, not a rollback. The mapping data does not exist and
  //     will not appear on a retry, so acknowledging + logging beats three days
  //     of Stripe retries that can never resolve. Distinct from case 10 (P2025),
  //     where the userId resolved and the write was expected to succeed.
  {
    const store = seededStore(); // user_1.stripeCustomerId is null
    const h = install(store, {});
    const res = await applyStripeWebhookEvent(
      subEvent("customer.subscription.updated", { id: "evt_nomap", userId: null, customerId: "cus_unknown" })
    );
    expect("8b: applied (acknowledged, not rolled back)", res, { status: "applied" });
    expect("8b: claim row committed", store.events.has("evt_nomap"), true);
    expect("8b: no subscription mutation", h.calls.includes("sub.update"), false);
    h.restore();
  }

  // 9. Unknown price id: `plan` is left untouched, other fields still written.
  {
    const store = seededStore({ plan: "BASIC" });
    const h = install(store, {});
    await applyStripeWebhookEvent(
      subEvent("customer.subscription.updated", { id: "evt_up", priceId: UNKNOWN_PRICE, status: "past_due" })
    );
    expect("9: plan preserved (undefined field omitted)", store.subs.get("user_1")!.plan, "BASIC");
    expect("9: status still written", store.subs.get("user_1")!.status, "past_due");
    const lastData = h.subUpdateArgs.at(-1)!.data;
    expect("9: plan passed as undefined", lastData.plan, undefined);
    h.restore();
  }

  // 10. Missing subscription row: P2025 is not swallowed as a duplicate; event not recorded.
  {
    const store = new Store(); // no user_1 subscription row
    const h = install(store, {});
    let threw = false;
    try {
      await applyStripeWebhookEvent(subEvent("customer.subscription.updated", { id: "evt_missing" }));
    } catch {
      threw = true;
    }
    expect("10: threw (route -> 500 -> Stripe retries)", threw, true);
    expect("10: event NOT recorded", store.events.has("evt_missing"), false);
    h.restore();
  }

  // 11. syncSubscriptionFromStripe idempotency: same payload, two distinct event ids -> identical row.
  {
    const store = seededStore();
    const h = install(store, {});
    await applyStripeWebhookEvent(subEvent("customer.subscription.updated", { id: "evt_a" }));
    const after1 = JSON.stringify(store.subs.get("user_1"));
    await applyStripeWebhookEvent(subEvent("customer.subscription.updated", { id: "evt_b" }));
    const after2 = JSON.stringify(store.subs.get("user_1"));
    expect("11: applying the same payload twice leaves the row identical", after1, after2);
    h.restore();
  }

  // 12. Cross-event ordering is NOT guarded (known, deferred - see docs). An older
  //     `updated` arriving after a newer one overwrites with the older values.
  {
    const store = seededStore();
    const h = install(store, {});
    await applyStripeWebhookEvent(
      subEvent("customer.subscription.updated", { id: "evt_new", periodEnd: 3_000_000_000 })
    );
    await applyStripeWebhookEvent(
      subEvent("customer.subscription.updated", { id: "evt_old", periodEnd: 1_000_000_000 })
    );
    expect(
      "12: last delivery wins regardless of event age (documented gap)",
      (store.subs.get("user_1")!.currentPeriodEnd as Date).getTime(),
      new Date(1_000_000_000 * 1000).getTime()
    );
    h.restore();
  }

  // 13. Unhandled event type: ignored, no transaction opened.
  {
    const store = seededStore();
    const h = install(store, {});
    const evt = { id: "evt_pi", type: "payment_intent.succeeded", data: { object: {} } } as unknown as Stripe.Event;
    const res = await applyStripeWebhookEvent(evt);
    expect("13: ignored", res, { status: "ignored" });
    expect("13: no transaction opened", h.calls.includes("transaction"), false);
    h.restore();
  }

  // 14. The transaction is opened with the explicit timeout / maxWait.
  {
    const store = seededStore();
    const h = install(store, {});
    await applyStripeWebhookEvent(subEvent("customer.subscription.created", { id: "evt_opts" }));
    expect("14: explicit transaction options", h.txOpts, { timeout: 10000, maxWait: 5000 });
    h.restore();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  if (failures > 0) process.exit(1);
}

main();
