-- Daily snapshots of tracked pg_stat_statements queries (admin DB Monitor trend). Additive only.
CREATE TABLE "query_stat_daily" (
    "id"         TEXT NOT NULL,
    "date"       DATE NOT NULL,
    "label"      TEXT NOT NULL,
    "calls"      BIGINT NOT NULL,
    "rows"       BIGINT NOT NULL,
    "avgRows"    DOUBLE PRECISION NOT NULL,
    "statsReset" BOOLEAN NOT NULL DEFAULT false,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "query_stat_daily_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "query_stat_daily_date_label_key" ON "query_stat_daily"("date", "label");

CREATE TABLE "query_stat_baselines" (
    "queryid"   TEXT NOT NULL,
    "label"     TEXT,
    "calls"     BIGINT NOT NULL,
    "rows"      BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "query_stat_baselines_pkey" PRIMARY KEY ("queryid")
);

ALTER TABLE "query_stat_daily" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "query_stat_baselines" ENABLE ROW LEVEL SECURITY;
