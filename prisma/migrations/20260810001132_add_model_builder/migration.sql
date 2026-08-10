-- CreateEnum
CREATE TYPE "ModelTarget" AS ENUM ('FAVORITE_ML', 'UNDERDOG_ML', 'OVER', 'UNDER');

-- CreateTable
CREATE TABLE "team_tendencies" (
    "id" TEXT NOT NULL,
    "sportKey" TEXT NOT NULL,
    "teamName" TEXT NOT NULL,
    "favWins" INTEGER NOT NULL DEFAULT 0,
    "favLosses" INTEGER NOT NULL DEFAULT 0,
    "favPushes" INTEGER NOT NULL DEFAULT 0,
    "dogWins" INTEGER NOT NULL DEFAULT 0,
    "dogLosses" INTEGER NOT NULL DEFAULT 0,
    "dogPushes" INTEGER NOT NULL DEFAULT 0,
    "overCount" INTEGER NOT NULL DEFAULT 0,
    "underCount" INTEGER NOT NULL DEFAULT 0,
    "totalPushCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_tendencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_models" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target" "ModelTarget" NOT NULL,
    "conditions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_models_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "team_tendencies_sportKey_teamName_key" ON "team_tendencies"("sportKey", "teamName");

-- CreateIndex
CREATE INDEX "user_models_userId_idx" ON "user_models"("userId");

-- AddForeignKey
ALTER TABLE "user_models" ADD CONSTRAINT "user_models_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
