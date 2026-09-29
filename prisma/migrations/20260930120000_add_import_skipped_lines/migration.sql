-- CreateEnum
CREATE TYPE "ImportSkipStage" AS ENUM ('PARSE_SILENT', 'PARSE_UNRESOLVED', 'PROP_UNSUPPORTED', 'RECOVERY_UNRESOLVED', 'DUPLICATE_SKIPPED', 'GAME_UNMATCHED', 'TOTAL_NO_LINE', 'INVALID_ODDS', 'DOUBLEHEADER_FINAL');

-- CreateTable
CREATE TABLE "import_skipped_lines" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "capperName" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "guessedSport" TEXT,
    "stage" "ImportSkipStage" NOT NULL,
    "reason" TEXT,
    "marketHint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_skipped_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_skipped_lines_stage_createdAt_idx" ON "import_skipped_lines"("stage", "createdAt");

-- CreateIndex
CREATE INDEX "import_skipped_lines_marketHint_idx" ON "import_skipped_lines"("marketHint");

-- AddForeignKey
ALTER TABLE "import_skipped_lines" ADD CONSTRAINT "import_skipped_lines_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same deny-all RLS posture as every other table (see
-- 20260915120000_enable_rls_on_all_tables).
ALTER TABLE "import_skipped_lines" ENABLE ROW LEVEL SECURITY;

-- Feature flag gating the admin report (same pattern as zone_model): OFF
-- globally, with standing per-user overrides for the two admins, matched by
-- email at deploy time (a no-op where the user doesn't exist, e.g. CI DBs).
INSERT INTO "feature_flags" ("key", "enabled", "updatedAt")
VALUES ('import_skipped_lines', false, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "feature_flag_user_overrides" ("id", "flagKey", "userId", "enabled", "updatedAt")
SELECT 'seed-import-skipped-lines-admin', 'import_skipped_lines', "id", true, CURRENT_TIMESTAMP
FROM "users"
WHERE "email" = 'bishopdykes@gmail.com'
ON CONFLICT ("flagKey", "userId") DO NOTHING;

INSERT INTO "feature_flag_user_overrides" ("id", "flagKey", "userId", "enabled", "updatedAt")
SELECT 'seed-import-skipped-lines-admin-xstavpac', 'import_skipped_lines', "id", true, CURRENT_TIMESTAMP
FROM "users"
WHERE "email" = 'xstavpac@gmail.com'
ON CONFLICT ("flagKey", "userId") DO NOTHING;
