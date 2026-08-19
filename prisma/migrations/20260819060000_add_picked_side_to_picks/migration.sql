-- CreateEnum
CREATE TYPE "PickedSide" AS ENUM ('HOME', 'AWAY');

-- AlterTable
ALTER TABLE "picks" ADD COLUMN     "pickedSide" "PickedSide";
