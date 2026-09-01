# M7 — Stripe webhook idempotency vs. transient failure

**Status (2026-08-31):** Fixed via Design B (transactional claim + mutation).
Shipped. This supersedes the M7 line in `scale-readiness-followups.md`.

**Epistemic tags**
- **Verified** — established directly from this repository or current Stripe docs.
- **[ESTIMATE]** — modeled; not measured in production.

---

## 1. The defect

`src/app/api/webhooks/stripe/route.ts` previously did, in order:

1. `markWebhookEventProcessed(event.id, event.type)` — an `INSERT` into
   `stripe_webhook_events`, **autocommitted**, *before* any handling.
2. `try { switch (event.type) { … subscription writes … } }` — separate
   autocommit statements.
3. `catch` → `console.error` → **HTTP 500**.

The old catch comment stated the tradeoff explicitly:

> *"The event is already marked processed (claimed above) even though handling
> it threw … Deliberate tradeoff: idempotency (never double-apply) over
> automatic retry-until-success for this specific failure mode."*

**Failure sequence:** the claim `INSERT` commits (step 1). The subscription
`update` throws transiently (pool timeout under `connection_limit=1`
contention, statement timeout, transient TCP reset). Step 3 returns 500.
Stripe retries (Verified: *"up to three days with an exponential back off in
live mode"*). The retry calls `markWebhookEventProcessed` again → the row
exists → `P2002` → returns `false` → the route returns **200** at the
duplicate-skip branch and **never enters the switch**. The subscription
mutation for that event is lost permanently. The only trace is one
`console.error` line; nothing retries, nothing alerts, and the schema has no
"failed" state to query (`stripe_webhook_events` is `id` PK + `type` +
`processedAt`, no status column).

At 50k users, transient DB failures become materially more common, so "a
human reads the log and repairs by hand" does not scale.

## 2. Stripe's guidance vs. the old implementation

From `https://docs.stripe.com/webhooks` (fetched 2026-08-31):

| Stripe says | Old code |
|---|---|
| *"guard against duplicated event receipts by logging the event IDs you've processed"* | ✅ `stripe_webhook_events` table keyed by `event.id` |
| non-2xx ⇒ Stripe retries (3 days, exponential backoff) | ⚠️ We returned 500 **and then defeated the retry** by having recorded the id pre-handler |
| example handlers return `500` on error and **expect the retry to re-run the work** | ❌ Our retry was a guaranteed no-op |
| *"Quickly return a 2xx … before any complex logic"* / *"Handle events asynchronously … with an asynchronous queue"* | ❌ Synchronous processing (see §5, deferred) |

The dedupe *table* matched Stripe's guidance; the *record-then-handle,
non-atomically* ordering is what broke the retry contract.

## 3. The fix — Design B (implemented)

`src/server/data/stripe-webhook.ts` → `applyStripeWebhookEvent(event, deps?)`:

```
if event.type not handled            -> return { status: "ignored" }   (no transaction)

if event.type == checkout.session.completed:
    resolve userId / subscriptionId / customerId from the Checkout Session
    retrieve the Stripe Subscription object     <-- external API call, OUTSIDE any transaction
    (malformed session -> log, checkoutContext stays null)

prisma.$transaction(async (tx) => {
    await tx.stripeWebhookEvent.create({ id: event.id, type })   <-- the claim, FIRST statement
    await dispatchWebhookEvent(tx, event, checkoutContext)        <-- every subscription write uses tx
}, { timeout: 10_000, maxWait: 5_000 })

catch P2002  -> return { status: "duplicate" }   (whole tx rolled back; nothing re-applied)
catch other  -> rethrow                          (whole tx, incl. the claim row, rolled back)
```

The route (`route.ts`) is now just: verify signature → `applyStripeWebhookEvent`
→ map result:

| Result | HTTP | Meaning |
|---|---|---|
| `applied` | 200 | transaction committed (mutation applied, or an intentional no-op like `invoice.payment_failed` / unresolvable user) |
| `duplicate` | 200 | event id already recorded by an earlier delivery |
| `ignored` | 200 | event type this endpoint does not act on |
| *thrown* | 500 + structured `console.error({ tag: "stripe-webhook-failed", eventId, type })` | transient failure; **the claim row rolled back**; Stripe retries and reprocesses cleanly |

### Why this preserves exactly-once *and* fixes the loss

- **Transient failure:** the mutation and the claim commit together or roll
  back together. A rolled-back claim means Stripe's retry finds no row and
  reprocesses — Stripe's retry model is now honored, not defeated.
- **Duplicate delivery:** the claim `INSERT` is the first statement, so a
  `P2002` can only be the `stripe_webhook_events` primary key ⇒ `duplicate`
  ⇒ no re-apply.
- **Concurrent duplicate deliveries:** the second transaction's claim `INSERT`
  blocks on the first's uncommitted unique key, then `P2002`s (first
  committed) or succeeds (first rolled back). Exactly one mutation lands.
- **Committed `stripe_webhook_events` row ⇔ its mutation committed.** Always.

### Constraints respected

- **The Stripe API call is hoisted out of the transaction** — never hold a DB
  transaction open across a network round-trip. `checkout.session.completed`
  fetches the Subscription first, then transacts.
- **`connection_limit=1`:** every DB call *inside* the `$transaction` callback
  goes through `tx`, never the bare `prisma` singleton — a singleton call
  mid-transaction would deadlock waiting for the one connection the
  transaction already holds. `findUserIdByStripeCustomerId` /
  `setStripeCustomerId` / `syncSubscriptionFromStripe` therefore each take an
  optional `db` param (defaults to `prisma`).
- **Interactive transactions are proven against this pooler:**
  `createPicksWithEntitlementCheck` already runs
  `prisma.$transaction(async (tx) => { … FOR UPDATE … })` in production
  against the same `pgbouncer=true&connection_limit=1` Supavisor pooler.
- **`{ timeout: 10_000, maxWait: 5_000 }`** — the webhook writes are 1–2
  single-row updates, far inside 10 s; the explicit values give headroom
  under contention over Prisma's 5 s default.

### Designs considered and rejected

- **Design A — mark processed only *after* the handler succeeds.** Simpler
  diff, but loses the up-front dedupe claim: two concurrent deliveries both
  run the full handler, and the guarantee degrades from exactly-once to
  at-least-once + reliance on idempotency. Reopens the ordering hazard with
  no serialization.
- **Design C — durable failed-events queue.** A `status`
  (`PENDING`/`PROCESSED`/`FAILED`) column + `attempts` + `lastError` on
  `stripe_webhook_events`, plus a replay cron. Best observability, pairs with
  the C4 queue direction — but needs Design B's transactional rigor *anyway*
  (to stop two workers double-processing), *plus* a migration, *plus* a cron,
  *plus* replay idempotency. Heavier than the bug warrants now. **Recorded as
  the future step** (see §5).

## 4. Tests

New (both pure, registered in `scripts/run-tests.mjs` `PURE_DESPITE_PRISMA_IMPORT`
where they touch `prisma`):

- **`src/server/data/stripe-webhook-acceptance-test.ts`** — `prisma.$transaction`
  is replaced with an in-memory transactional store (staging copy on entry,
  adopted on success, **discarded on throw** — real rollback semantics); the
  Stripe API call is injected via `deps.retrieveSubscription`. 14 case groups:
  1. happy path applies + records
  2. duplicate delivery → no re-apply
  3. **mid-handler failure → claim row NOT recorded** *(core M7 proof, part 1)*
  4. **retry of #3 → applies the update** *(core M7 proof, part 2)*
  5. concurrent duplicates, first commits → second no-ops
  6. concurrent duplicates, first rolls back → second applies
  7. `checkout.session.completed`: Stripe retrieve runs **before** the
     transaction; both writes use `tx`
  7b. malformed checkout session → no Stripe call, claim recorded, no mutation
  8. `invoice.payment_failed` → recorded, no entitlement change
  8b. unresolvable userId (no `metadata.userId`, customer matches no row) →
      claim **commits**, no mutation, 200 — a deliberate no-op (the mapping
      data won't appear on a retry), distinct from case 10's `P2025` rollback
  9. unknown price id → `plan` left untouched, other fields written
  10. missing subscription row (`P2025`) → not swallowed as duplicate; event
      not recorded; rethrows (→ 500 → Stripe retries)
  11. `syncSubscriptionFromStripe` idempotency — same payload twice → identical row
  12. cross-event ordering is **not** guarded (locks in the known gap)
  13. unhandled type → `ignored`, no transaction
  14. transaction opened with `{ timeout: 10000, maxWait: 5000 }`
- **`src/lib/entitlements-acceptance-test.ts`** — pure matrix over
  `isEntitledToPaidTier` / `resolveEffectiveTier`: `active` / `trialing` /
  `past_due` (× future/past/null period), `canceled` immediate vs. scheduled,
  `unpaid` / `incomplete` / `incomplete_expired` / `paused`, `FREE`, no
  subscription. Previously zero coverage.

## 5. Deferred — the future async-processing step (Design C)

Stripe: *"Handle events asynchronously … a large spike in webhook deliveries
(for example, at the beginning of the month when all subscriptions renew) might
overwhelm your endpoint hosts."* Our webhook still processes synchronously.

When webhook volume justifies it (month-start renewal spikes at 50k users are
the billing analogue of a football-Sunday grading spike), move to Design C:

- Add `status` (`PENDING` / `PROCESSED` / `FAILED`), `attempts`, `lastError`,
  `updatedAt` to `stripe_webhook_events` (migration).
- Claim as `PENDING`; on success `PROCESSED`; on failure `FAILED` + error.
- Dedupe skip only on `PROCESSED`; a cron replays `FAILED` / stale-`PENDING`.
- Concurrency still guarded by Design B's transactional claim (or a
  conditional `updateMany({ where: { id, status: "PENDING" } })`).

This is the same direction as C4's queue work and crosses the
migration/cron/infra-approval boundary, so it is its own task.

## 6. Explicitly out of scope for this fix

- No schema migration; no `vercel.json` / cron / `maxDuration` change; no queue;
  no `connection_limit` change.
- **Cross-event ordering** — an older `customer.subscription.updated` arriving
  after a newer one overwrites with the older values (last-writer-wins). Test
  #12 locks in that we know this. A future guard would gate writes on
  `event.created >= subscription.lastEventAt`. Not built here.
- **`auth.ts` pre-existing-email gap** — `upsertUserFromSupabase`'s
  "existing email" branch (`auth.ts:74-83`) updates the user without creating
  a `Subscription` row. The webhook's `update` would then `P2025`; with this
  fix that now *retries* (500) instead of silently stranding, but the row
  should arguably be auto-created. Separate concern.
