-- CreateTable
CREATE TABLE "dismissed_duplicate_pairs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "capperAId" TEXT NOT NULL,
    "capperBId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dismissed_duplicate_pairs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dismissed_duplicate_pairs_userId_idx" ON "dismissed_duplicate_pairs"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "dismissed_duplicate_pairs_capperAId_capperBId_key" ON "dismissed_duplicate_pairs"("capperAId", "capperBId");

-- AddForeignKey
ALTER TABLE "dismissed_duplicate_pairs" ADD CONSTRAINT "dismissed_duplicate_pairs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dismissed_duplicate_pairs" ADD CONSTRAINT "dismissed_duplicate_pairs_capperAId_fkey" FOREIGN KEY ("capperAId") REFERENCES "cappers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dismissed_duplicate_pairs" ADD CONSTRAINT "dismissed_duplicate_pairs_capperBId_fkey" FOREIGN KEY ("capperBId") REFERENCES "cappers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
