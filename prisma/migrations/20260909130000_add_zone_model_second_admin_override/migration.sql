-- Grant a second admin standing access to zone_model, same pattern as
-- migration 20260909120000_add_feature_flags's original seed: matched by
-- email at deploy time (not a hardcoded id, since ids differ across
-- environments), independent of the global `feature_flags.enabled` switch,
-- and a no-op if no user with this email exists yet in this database.
INSERT INTO "feature_flag_user_overrides" ("id", "flagKey", "userId", "enabled", "updatedAt")
SELECT 'seed-zone-model-admin-xstavpac', 'zone_model', "id", true, CURRENT_TIMESTAMP
FROM "users"
WHERE "email" = 'xstavpac@gmail.com'
ON CONFLICT ("flagKey", "userId") DO NOTHING;
