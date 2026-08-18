-- CreateTable
CREATE TABLE "parlay_bets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "capperId" TEXT NOT NULL,
    "units" DOUBLE PRECISION NOT NULL,
    "datePosted" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "status" "PickStatus" NOT NULL DEFAULT 'PENDING',
    "gradedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parlay_bets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legs" (
    "id" TEXT NOT NULL,
    "parlayBetId" TEXT NOT NULL,
    "legIndex" INTEGER NOT NULL,
    "sportId" TEXT NOT NULL,
    "leagueId" TEXT,
    "homeTeam" TEXT NOT NULL,
    "awayTeam" TEXT NOT NULL,
    "betType" "BetType" NOT NULL,
    "betDetail" TEXT,
    "odds" INTEGER NOT NULL,
    "line" DOUBLE PRECISION,
    "period" "Period" NOT NULL DEFAULT 'FULL_GAME',
    "gameTime" TIMESTAMP(3) NOT NULL,
    "status" "PickStatus" NOT NULL DEFAULT 'PENDING',
    "gradedAt" TIMESTAMP(3),
    "gradedViaFuzzyMatch" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "parlay_bets_userId_capperId_idx" ON "parlay_bets"("userId", "capperId");

-- CreateIndex
CREATE INDEX "parlay_bets_userId_status_idx" ON "parlay_bets"("userId", "status");

-- CreateIndex
CREATE INDEX "legs_sportId_status_idx" ON "legs"("sportId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "legs_parlayBetId_legIndex_key" ON "legs"("parlayBetId", "legIndex");

-- AddForeignKey
ALTER TABLE "parlay_bets" ADD CONSTRAINT "parlay_bets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parlay_bets" ADD CONSTRAINT "parlay_bets_capperId_fkey" FOREIGN KEY ("capperId") REFERENCES "cappers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legs" ADD CONSTRAINT "legs_parlayBetId_fkey" FOREIGN KEY ("parlayBetId") REFERENCES "parlay_bets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legs" ADD CONSTRAINT "legs_sportId_fkey" FOREIGN KEY ("sportId") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legs" ADD CONSTRAINT "legs_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "leagues"("id") ON DELETE SET NULL ON UPDATE CASCADE;
