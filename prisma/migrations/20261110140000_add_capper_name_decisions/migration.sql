-- CreateTable
CREATE TABLE "capper_name_decisions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rawKey" TEXT NOT NULL,
    "suggestedKey" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capper_name_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "capper_name_decisions_userId_rawKey_suggestedKey_key" ON "capper_name_decisions"("userId", "rawKey", "suggestedKey");

-- AddForeignKey
ALTER TABLE "capper_name_decisions" ADD CONSTRAINT "capper_name_decisions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row level security on with no policies: the app reads and writes through Prisma
-- (a role that bypasses RLS); the Supabase API roles get no access.
ALTER TABLE "capper_name_decisions" ENABLE ROW LEVEL SECURITY;
