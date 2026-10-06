import { prisma } from "@/lib/prisma";
import { cacheKeys } from "@/lib/cache-keys";
import { cachedByTag } from "@/server/data/cached";

// Key for Zone Model's admin gate (see zone-model.ts). Not an env var and
// not a hardcoded email/id check - a row in the `feature_flags` table
// (migration 20260909120000_add_feature_flags), seeded OFF globally with one
// FeatureFlagUserOverride granting the admin building it standing access.
// Flipping `feature_flags.enabled` to true later ships this to everyone,
// with zero new code.
export const ZONE_MODEL_FLAG_KEY = "zone_model";

// Admin report over the import skipped-line log (see /admin/import-skipped-lines).
// Seeded OFF with overrides for the admins in migration
// 20260930120000_add_import_skipped_lines.
export const IMPORT_SKIPPED_LINES_FLAG_KEY = "import_skipped_lines";

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

// ---------------------------------------------------------------------------
// Navigation-only read: which flags to show in the sidebar
// ---------------------------------------------------------------------------

// The (app) layout asks about every flag on every page load. Asked one at a
// time through isFeatureEnabledForUser that was two statements per flag per
// page load, for an answer that is the same for nearly every user and changes
// only when someone edits the flag tables by hand.
//
// So the layout reads ONE shared snapshot instead: every flag, its global
// switch, and the ids of the users it is individually switched on for, cached
// for FEATURE_FLAGS_CACHE_TTL_SECONDS across the fleet and resolved per user
// in memory. A flag flip therefore reaches the sidebar within that TTL.
//
// This is for deciding what to DRAW only. The gated routes themselves
// (/zone-model, /admin/import-skipped-lines) keep calling
// isFeatureEnabledForUser, uncached, so granting or revoking access takes
// effect on the route immediately - a stale snapshot can show or hide a link
// for up to a minute, never open or close the page behind it.
//
// Sized for what the override table is today: a handful of admin rows. If
// overrides ever become a per-user rollout mechanism (thousands of rows), this
// snapshot stops being small and should be split per flag or per user.
export const FEATURE_FLAGS_CACHE_TTL_SECONDS = 60;

export type FeatureFlagSnapshot = { key: string; enabled: boolean; enabledUserIds: string[] }[];

export async function loadFeatureFlagSnapshot(): Promise<FeatureFlagSnapshot> {
  const flags = await prisma.featureFlag.findMany({
    select: { key: true, enabled: true, userOverrides: { where: { enabled: true }, select: { userId: true } } },
  });
  return flags.map((f) => ({ key: f.key, enabled: f.enabled, enabledUserIds: f.userOverrides.map((o) => o.userId) }));
}

// Same rule as isFeatureEnabledForUser, over the snapshot: on globally, or on
// for this user. An unknown flag fails closed.
export function isEnabledInSnapshot(snapshot: FeatureFlagSnapshot, key: string, userId: string): boolean {
  const flag = snapshot.find((f) => f.key === key);
  if (!flag) return false;
  return flag.enabled || flag.enabledUserIds.includes(userId);
}

// One result per requested key, in order.
export async function getNavFeatureFlags(keys: string[], userId: string): Promise<boolean[]> {
  const snapshot = await cachedByTag(cacheKeys.featureFlags(), FEATURE_FLAGS_CACHE_TTL_SECONDS, loadFeatureFlagSnapshot);
  return keys.map((key) => isEnabledInSnapshot(snapshot, key, userId));
}
