// Proof for the Zone Model access-control gate (src/server/data/feature-flags.ts):
// the admin account sees the feature via a per-user override while the flag
// is globally off, an unrelated account does not, and flipping the flag's
// global `enabled` alone (no override, no code change) makes it visible to
// everyone - the exact "ship to all users later" mechanism the flag was
// designed for.
//
// Pure: the prisma singleton's `featureFlag.findUnique` is swapped for a
// spy before each call, so no database is touched - same convention as
// team-tendencies-acceptance-test.ts. Run with:
//   npx tsx src/server/data/feature-flags-acceptance-test.ts
import { prisma } from "@/lib/prisma";
import { isFeatureEnabledForUser, ZONE_MODEL_FLAG_KEY } from "@/server/data/feature-flags";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const originals: Record<string, unknown> = {};
function patch(path: string, fn: unknown) {
  const [model, method] = path.split(".");
  const target = (prisma as unknown as Record<string, Record<string, unknown>>)[model];
  originals[path] ??= target[method];
  target[method] = fn;
}
function restoreAll() {
  for (const path of Object.keys(originals)) {
    const [model, method] = path.split(".");
    (prisma as unknown as Record<string, Record<string, unknown>>)[model][method] = originals[path];
  }
}

const ADMIN_USER_ID = "user-admin";
const OTHER_USER_ID = "user-other";

// findUnique's `include.userOverrides.where.userId` filtering is real Prisma
// behavior, not something this spy can execute generically - so the spy
// itself takes the requesting userId's override state directly, exactly
// mirroring what a real query would already have filtered down to.
function mockFlagFor(userId: string, enabled: boolean, overrideForThisUser: boolean | undefined) {
  return async (args: { where: { key: string } }) => {
    if (args.where.key !== ZONE_MODEL_FLAG_KEY) return null;
    return {
      key: ZONE_MODEL_FLAG_KEY,
      enabled,
      userOverrides: overrideForThisUser === undefined ? [] : [{ userId, enabled: overrideForThisUser }],
    };
  };
}

async function main() {
  // ---- 1. Flag globally OFF, admin has an enabled override -> admin sees it ----
  patch("featureFlag.findUnique", mockFlagFor(ADMIN_USER_ID, false, true));
  expect("admin with an enabled override sees the feature while flag is globally off", await isFeatureEnabledForUser(ZONE_MODEL_FLAG_KEY, ADMIN_USER_ID), true);

  // ---- 2. Flag globally OFF, other account has no override row at all -> does not see it ----
  patch("featureFlag.findUnique", mockFlagFor(OTHER_USER_ID, false, undefined));
  expect("other account with no override does not see the feature while flag is globally off", await isFeatureEnabledForUser(ZONE_MODEL_FLAG_KEY, OTHER_USER_ID), false);

  // ---- 3. Toggling the flag's global `enabled` to true makes it visible to an account with NO override ----
  // This is the entire "ship to everyone" rollout mechanism: one DB value
  // flip, zero new code, zero per-user rows needed.
  patch("featureFlag.findUnique", mockFlagFor(OTHER_USER_ID, true, undefined));
  expect("flipping the flag's global `enabled` alone grants access with no per-user override", await isFeatureEnabledForUser(ZONE_MODEL_FLAG_KEY, OTHER_USER_ID), true);

  // ---- 4. An explicit override with enabled:false is a revoke, not a grant ----
  patch("featureFlag.findUnique", mockFlagFor(OTHER_USER_ID, false, false));
  expect("an override explicitly set to enabled:false does NOT grant access", await isFeatureEnabledForUser(ZONE_MODEL_FLAG_KEY, OTHER_USER_ID), false);

  // ---- 5. No flag row at all for this key -> fails closed ----
  patch("featureFlag.findUnique", async () => null);
  expect("a feature key with no flag row at all fails closed (false)", await isFeatureEnabledForUser("some_other_feature", ADMIN_USER_ID), false);

  restoreAll();
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  if (failures > 0) process.exit(1);
}

main();
