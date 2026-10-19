-- Feature flag gating the /admin ops console (layout, every page under it and
-- every admin server action - see src/server/admin-gate.ts). Same pattern as
-- zone_model / import_skipped_lines: OFF globally, with standing per-user
-- overrides for the two admin accounts, matched by email at deploy time (a
-- no-op where the user doesn't exist, e.g. CI DBs). Data only, no DDL.
INSERT INTO "feature_flags" ("key", "enabled", "updatedAt")
VALUES ('admin_ops_console', false, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "feature_flag_user_overrides" ("id", "flagKey", "userId", "enabled", "updatedAt")
SELECT 'seed-admin-ops-console-bishopdykes', 'admin_ops_console', "id", true, CURRENT_TIMESTAMP
FROM "users"
WHERE "email" = 'bishopdykes@gmail.com'
ON CONFLICT ("flagKey", "userId") DO NOTHING;

INSERT INTO "feature_flag_user_overrides" ("id", "flagKey", "userId", "enabled", "updatedAt")
SELECT 'seed-admin-ops-console-xstavpac', 'admin_ops_console', "id", true, CURRENT_TIMESTAMP
FROM "users"
WHERE "email" = 'xstavpac@gmail.com'
ON CONFLICT ("flagKey", "userId") DO NOTHING;
