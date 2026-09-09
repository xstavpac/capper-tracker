import { prisma } from "@/lib/prisma";

// Key for Zone Model's admin gate (see zone-model.ts). Not an env var and
// not a hardcoded email/id check - a row in the `feature_flags` table
// (migration 20260909120000_add_feature_flags), seeded OFF globally with one
// FeatureFlagUserOverride granting the admin building it standing access.
// Flipping `feature_flags.enabled` to true later ships this to everyone,
// with zero new code.
export const ZONE_MODEL_FLAG_KEY = "zone_model";

// A user has access to `key` when EITHER the flag's global `enabled` is
// true (the eventual "everyone" rollout - a single DB value flip, no code
// change) OR they have a FeatureFlagUserOverride row for it with
// `enabled: true` (today's admin-only scoping). A flag row that doesn't
// exist yet fails closed (false), same as any other feature nobody has
// turned on.
export async function isFeatureEnabledForUser(key: string, userId: string): Promise<boolean> {
  const flag = await prisma.featureFlag.findUnique({
    where: { key },
    include: { userOverrides: { where: { userId } } },
  });
  if (!flag) return false;
  if (flag.enabled) return true;
  return flag.userOverrides.some((override) => override.enabled);
}
