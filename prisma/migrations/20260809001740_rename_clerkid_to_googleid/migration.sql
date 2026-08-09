-- Clerk -> Google OAuth (NextAuth) migration. No real users yet - the 2
-- existing dev/test rows get a temporary placeholder (their old clerkId
-- value, already unique) so the NOT NULL + UNIQUE constraints below can be
-- added safely. upsertUserFromGoogleProfile (src/server/auth.ts) matches an
-- existing row by email on first real Google sign-in and overwrites this
-- placeholder with the real Google subject id, so the account (and all its
-- picks/cappers) carries over rather than starting fresh.
ALTER TABLE "users" ADD COLUMN "googleId" TEXT;
UPDATE "users" SET "googleId" = "clerkId";
ALTER TABLE "users" ALTER COLUMN "googleId" SET NOT NULL;
DROP INDEX "users_clerkId_key";
ALTER TABLE "users" DROP COLUMN "clerkId";
CREATE UNIQUE INDEX "users_googleId_key" ON "users"("googleId");
