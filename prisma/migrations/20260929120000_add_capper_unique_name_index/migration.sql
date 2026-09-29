-- One capper name per user, compared case-insensitively and ignoring
-- leading/trailing spaces. Raw SQL: Prisma 5 cannot express an expression
-- index, so this is NOT declared in schema.prisma (see docs/partial-indexes.md).
--
-- If any user already has two cappers that collide under this expression,
-- CREATE UNIQUE INDEX fails and so does the deploy. Check first:
--   SELECT "userId", lower(btrim(name)) AS n, count(*) FROM cappers GROUP BY 1, 2 HAVING count(*) > 1;
CREATE UNIQUE INDEX "cappers_user_lower_name_key" ON "cappers" ("userId", lower(btrim("name")));
