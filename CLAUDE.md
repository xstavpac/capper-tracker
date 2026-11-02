# CLAUDE.md

## Supabase egress

Supabase egress is a first-class constraint on every change.

- Every investigation report and every PR description includes an "Egress impact" section: new or changed DB reads, estimated rows and bytes per request, per cron run and per day, and whether that is more or less than today.
- Aggregate in Postgres (SQL, views, rollup tables). Never fetch raw pick history into the app to compute stats.
- Select only the columns you need. No `findMany` without a `select`, no unbounded reads, no JSON detail columns in list queries.
- Prefer caching or precomputed rollups over repeated reads. Don't add polling.
- If a change increases egress meaningfully, stop and report before building.
