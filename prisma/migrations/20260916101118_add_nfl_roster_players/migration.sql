-- CreateTable
CREATE TABLE "nfl_roster_players" (
    "id" TEXT NOT NULL,
    "espnPlayerId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nfl_roster_players_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "nfl_roster_players_espnPlayerId_key" ON "nfl_roster_players"("espnPlayerId");

-- CreateIndex
CREATE INDEX "nfl_roster_players_team_idx" ON "nfl_roster_players"("team");

-- CreateIndex
CREATE INDEX "nfl_roster_players_lastName_idx" ON "nfl_roster_players"("lastName");

-- Same deny-all RLS posture the 20260915120000_enable_rls_on_all_tables
-- migration applied to every existing table (see that migration's header) -
-- a new table must get it too, or Supabase's security advisor flags it the
-- same way it flagged the others.
ALTER TABLE "nfl_roster_players" ENABLE ROW LEVEL SECURITY;
