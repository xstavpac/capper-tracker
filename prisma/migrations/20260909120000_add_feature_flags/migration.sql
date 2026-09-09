-- CreateTable
CREATE TABLE "feature_flags" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "feature_flag_user_overrides" (
    "id" TEXT NOT NULL,
    "flagKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flag_user_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "feature_flag_user_overrides_flagKey_userId_key" ON "feature_flag_user_overrides"("flagKey", "userId");

-- AddForeignKey
ALTER TABLE "feature_flag_user_overrides" ADD CONSTRAINT "feature_flag_user_overrides_flagKey_fkey" FOREIGN KEY ("flagKey") REFERENCES "feature_flags"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_flag_user_overrides" ADD CONSTRAINT "feature_flag_user_overrides_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the zone_model flag itself: OFF for everyone by default. Flipping
-- `enabled` to true on this one row later is the entire "ship to everyone"
-- rollout - no code change, no new migration.
INSERT INTO "feature_flags" ("key", "enabled", "updatedAt")
VALUES ('zone_model', false, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- Grant the admin building this feature standing access via an override,
-- independent of the global switch above. Matched by email at deploy time
-- (not a hardcoded id, since ids differ across environments) - a no-op if no
-- user with this email exists yet in this database (fresh CI/dev DBs).
INSERT INTO "feature_flag_user_overrides" ("id", "flagKey", "userId", "enabled", "updatedAt")
SELECT 'seed-zone-model-admin', 'zone_model', "id", true, CURRENT_TIMESTAMP
FROM "users"
WHERE "email" = 'bishopdykes@gmail.com'
ON CONFLICT ("flagKey", "userId") DO NOTHING;
