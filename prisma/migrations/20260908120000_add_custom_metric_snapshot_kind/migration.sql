-- CreateEnum
CREATE TYPE "MetricKind" AS ENUM ('DAILY', 'SNAPSHOT');

-- AlterTable
ALTER TABLE "custom_metrics" ADD COLUMN     "metricKind" "MetricKind" NOT NULL DEFAULT 'DAILY',
ADD COLUMN     "periodLabel" TEXT;
