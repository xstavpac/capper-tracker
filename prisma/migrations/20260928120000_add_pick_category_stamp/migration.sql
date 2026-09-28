-- AlterTable
-- category: pickCategory() result stamped at insert (nullable - null is a real
-- pickCategory outcome). categoryVersion: 0 = never stamped. Both are
-- metadata-only on Postgres 11+ (constant default, no table rewrite).
ALTER TABLE "picks" ADD COLUMN     "category" TEXT,
ADD COLUMN     "categoryVersion" INTEGER NOT NULL DEFAULT 0;
