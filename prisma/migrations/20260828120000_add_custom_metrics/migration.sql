-- CreateTable
CREATE TABLE "custom_metrics" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sportKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'decimal',
    "hasTeamColumn" BOOLEAN NOT NULL,
    "sourceId" TEXT NOT NULL DEFAULT 'user_upload',
    "scope" "DataScope" NOT NULL DEFAULT 'PER_USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_metric_points" (
    "id" TEXT NOT NULL,
    "customMetricId" TEXT NOT NULL,
    "snapshotDate" TEXT NOT NULL,
    "teamName" TEXT,
    "value" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "custom_metric_points_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custom_metrics_userId_sportKey_idx" ON "custom_metrics"("userId", "sportKey");

-- CreateIndex
CREATE UNIQUE INDEX "custom_metric_points_customMetricId_snapshotDate_teamName_key" ON "custom_metric_points"("customMetricId", "snapshotDate", "teamName");

-- AddForeignKey
ALTER TABLE "custom_metrics" ADD CONSTRAINT "custom_metrics_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_metric_points" ADD CONSTRAINT "custom_metric_points_customMetricId_fkey" FOREIGN KEY ("customMetricId") REFERENCES "custom_metrics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
