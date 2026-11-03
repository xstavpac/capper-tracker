-- Pick recipients: accounts that also receive the source user's IMPORTED picks (admin-managed).
CREATE TYPE "PickRecipientStatus" AS ENUM ('ACTIVE', 'PAUSED');

CREATE TABLE "pick_recipients" (
    "id"              TEXT NOT NULL,
    "sourceUserId"    TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "status"          "PickRecipientStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pausedAt"        TIMESTAMP(3),
    "resumedAt"       TIMESTAMP(3),
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "pick_recipients_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pick_recipients_not_self" CHECK ("sourceUserId" <> "recipientUserId")
);
CREATE UNIQUE INDEX "pick_recipients_sourceUserId_recipientUserId_key" ON "pick_recipients"("sourceUserId", "recipientUserId");
CREATE INDEX "pick_recipients_sourceUserId_status_idx" ON "pick_recipients"("sourceUserId", "status");
ALTER TABLE "pick_recipients" ADD CONSTRAINT "pick_recipients_sourceUserId_fkey"    FOREIGN KEY ("sourceUserId")    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pick_recipients" ADD CONSTRAINT "pick_recipients_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Server-only table: RLS on, no policies.
ALTER TABLE "pick_recipients" ENABLE ROW LEVEL SECURITY;

-- Copy markers on picks (metadata-only on Postgres 11+, no table rewrite). No FK on sourcePickId on purpose:
-- deleting the source pick must neither fail nor un-mark the copy.
ALTER TABLE "picks" ADD COLUMN "isRecipientCopy" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "picks" ADD COLUMN "sourcePickId" TEXT;

-- Maria Barkho, active as soon as this deploys. Inserts nothing (no error) if either user is missing.
INSERT INTO "pick_recipients" ("id", "sourceUserId", "recipientUserId", "status", "updatedAt")
SELECT 'prc_' || substr(md5(random()::text || clock_timestamp()::text), 1, 21),
       s.id, r.id, 'ACTIVE', CURRENT_TIMESTAMP
FROM users s, users r
WHERE s.email = 'xstavpac@gmail.com' AND r.id = 'cmseemlc70000lxn3c1ihzyzl';
