// Matrix for isEntitledToPaidTier / resolveEffectiveTier - the single place
// that translates Stripe's subscription lifecycle into a yes/no access
// decision. A wrong-plan bug (the M7 failure mode) ultimately surfaces
// through this function, and it had zero test coverage before.
//
// Pure: no imports beyond the module under test. Run with:
//   npx tsx src/lib/entitlements-acceptance-test.ts
import { isEntitledToPaidTier, resolveEffectiveTier, type SubscriptionState } from "@/lib/entitlements";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const future = new Date(Date.now() + 30 * 86_400_000);
const past = new Date(Date.now() - 30 * 86_400_000);

function sub(over: Partial<NonNullable<SubscriptionState>>): SubscriptionState {
  return { plan: "BASIC", status: "active", currentPeriodEnd: future, cancelAtPeriodEnd: false, ...over };
}

const cases: { label: string; state: SubscriptionState; entitled: boolean; tier: string }[] = [
  { label: "no subscription", state: null, entitled: false, tier: "FREE" },
  { label: "plan FREE", state: sub({ plan: "FREE" }), entitled: false, tier: "FREE" },

  { label: "active + future period", state: sub({ status: "active" }), entitled: true, tier: "BASIC" },
  { label: "active + past period (webhook lag ceiling)", state: sub({ status: "active", currentPeriodEnd: past }), entitled: false, tier: "FREE" },
  { label: "active + null period", state: sub({ status: "active", currentPeriodEnd: null }), entitled: false, tier: "FREE" },

  { label: "trialing + future period", state: sub({ status: "trialing" }), entitled: true, tier: "BASIC" },
  { label: "past_due + future period", state: sub({ status: "past_due", plan: "PRO" }), entitled: true, tier: "PRO" },
  { label: "past_due + past period", state: sub({ status: "past_due", currentPeriodEnd: past }), entitled: false, tier: "FREE" },

  // canceled is two shapes told apart by cancelAtPeriodEnd, not the date.
  { label: "canceled immediate (cancelAtPeriodEnd false) even with future period", state: sub({ status: "canceled", cancelAtPeriodEnd: false, currentPeriodEnd: future }), entitled: false, tier: "FREE" },
  { label: "canceled scheduled (cancelAtPeriodEnd true) + future period still in grace", state: sub({ status: "canceled", cancelAtPeriodEnd: true, currentPeriodEnd: future }), entitled: true, tier: "BASIC" },
  { label: "canceled scheduled + past period", state: sub({ status: "canceled", cancelAtPeriodEnd: true, currentPeriodEnd: past }), entitled: false, tier: "FREE" },

  { label: "unpaid", state: sub({ status: "unpaid" }), entitled: false, tier: "FREE" },
  { label: "incomplete", state: sub({ status: "incomplete" }), entitled: false, tier: "FREE" },
  { label: "incomplete_expired", state: sub({ status: "incomplete_expired" }), entitled: false, tier: "FREE" },
  { label: "paused", state: sub({ status: "paused" }), entitled: false, tier: "FREE" },
];

for (const c of cases) {
  expect(`isEntitledToPaidTier: ${c.label}`, isEntitledToPaidTier(c.state), c.entitled);
  expect(`resolveEffectiveTier: ${c.label}`, resolveEffectiveTier(c.state), c.tier);
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
if (failures > 0) process.exit(1);
