-- NextAuth -> Supabase Auth migration. Still in beta, no real users besides
-- the account this app was built/tested with, which gets a temporary
-- placeholder (its old googleId, already unique) so the NOT NULL + UNIQUE
-- constraints below can be added safely. upsertUserFromSupabase (see
-- src/server/auth.ts) matches an existing row by email on that account's
-- first real Supabase sign-in and overwrites the placeholder with the real
-- Supabase auth user id, carrying the account (and all its picks/cappers)
-- forward instead of starting fresh.
ALTER TABLE "users" ADD COLUMN "supabaseId" TEXT;
UPDATE "users" SET "supabaseId" = "googleId";
ALTER TABLE "users" ALTER COLUMN "supabaseId" SET NOT NULL;
DROP INDEX "users_googleId_key";
ALTER TABLE "users" DROP COLUMN "googleId";
CREATE UNIQUE INDEX "users_supabaseId_key" ON "users"("supabaseId");
