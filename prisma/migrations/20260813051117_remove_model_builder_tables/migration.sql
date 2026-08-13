-- DropForeignKey
ALTER TABLE "user_models" DROP CONSTRAINT "user_models_userId_fkey";

-- DropTable
DROP TABLE "game_starters";

-- DropTable
DROP TABLE "user_models";

-- DropEnum
DROP TYPE "ModelTarget";

