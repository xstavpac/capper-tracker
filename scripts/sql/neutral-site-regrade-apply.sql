-- WRITES picks.status. Neutral-site wrong-team regrade: the 24 rows the read-only dry-run found on 2026-11-23
-- (score row reversed by full team names, stored status != grade by team). Each row carries its old status as a
-- guard: a pick re-graded since the dry-run is left alone. Expect "UPDATE 24".
-- Only status changes: picks store no profit/payout (derived from status at read time); gradedAt is left as is,
-- the way regradeFuzzyPool records a correction.
BEGIN;

WITH fix(id, old_status, new_status) AS (
  VALUES
    -- NCAAB Marquette Golden Eagles -1 (Missouri 69-64)
    ('cmwhwik1s001kwd3d4cwkr2iz', 'WIN', 'LOSS'), ('cmwhwik5h001pwd3djxbh6yh8', 'WIN', 'LOSS'), ('cmwhwik8b001uwd3dgyp93zck', 'WIN', 'LOSS'),
    -- NCAAB Marquette Golden Eagles ML
    ('cmwhxsy6q0016zbv9nj3jeqfd', 'WIN', 'LOSS'), ('cmwhxsyah001bzbv9gvpwgfwf', 'WIN', 'LOSS'), ('cmwhxsycj001gzbv9qi1hm8ar', 'WIN', 'LOSS'),
    -- NCAAB Murray State +3.5 (NC State 93-83)
    ('cmwo480mn01vf237mq3y2sa2e', 'WIN', 'LOSS'), ('cmwo480pp01vh237me30sf5dv', 'WIN', 'LOSS'), ('cmwo480rn01vj237m988c3uk5', 'WIN', 'LOSS'),
    -- NCAAB Murray State +4
    ('cmwnvwl2b003jkmdr81gx5mtd', 'WIN', 'LOSS'), ('cmwnvwl4v003nkmdrmc7g181u', 'WIN', 'LOSS'), ('cmwnvwl6w003rkmdrzj0jfzvc', 'WIN', 'LOSS'),
    -- NCAAB Western Kentucky +0.5 (WKU 82-68)
    ('cmwp9496601nrtfzntvmtzjuv', 'LOSS', 'WIN'), ('cmwp949b901o2tfzn2kdx41hh', 'LOSS', 'WIN'), ('cmwp949fx01odtfznyejksxe5', 'LOSS', 'WIN'),
    -- NCAAB Utah Valley -3.5 (Utah Valley 90-79)
    ('cmwp9496601nqtfzn4tvyspjy', 'LOSS', 'WIN'), ('cmwp949b901o1tfznjjq4bg54', 'LOSS', 'WIN'), ('cmwp949fx01octfzn0uxs7f0o', 'LOSS', 'WIN'),
    -- NCAAB UC Irvine -2.5 (LMU 72-68)
    ('cmws1gvag0017t8vn2tvocus2', 'WIN', 'LOSS'), ('cmws1gvdn001dt8vnowuq47lj', 'WIN', 'LOSS'), ('cmws1gvgd001jt8vns1p9swlz', 'WIN', 'LOSS'),
    -- NCAAF Virginia -10 (West Virginia 38-27, neutral site, 2026-09-19)
    ('cmu8pydjl002zccg6sfla892k', 'WIN', 'LOSS'), ('cmu8pydjq0063ccg6rmc3lvav', 'WIN', 'LOSS'),
    -- NCAAF West Virginia +10.5
    ('cmu8pydju008lccg6ewgjzg6h', 'LOSS', 'WIN')
)
UPDATE picks p
SET status = fix.new_status::"PickStatus", "updatedAt" = now()
FROM fix
WHERE p.id = fix.id AND p.status = fix.old_status::"PickStatus";

-- Check: 24 rows now carry the new status. Then COMMIT (or ROLLBACK if not 24).
SELECT count(*) AS now_regraded FROM picks WHERE id IN (
  'cmwhwik1s001kwd3d4cwkr2iz','cmwhwik5h001pwd3djxbh6yh8','cmwhwik8b001uwd3dgyp93zck','cmwhxsy6q0016zbv9nj3jeqfd','cmwhxsyah001bzbv9gvpwgfwf','cmwhxsycj001gzbv9qi1hm8ar',
  'cmwo480mn01vf237mq3y2sa2e','cmwo480pp01vh237me30sf5dv','cmwo480rn01vj237m988c3uk5','cmwnvwl2b003jkmdr81gx5mtd','cmwnvwl4v003nkmdrmc7g181u','cmwnvwl6w003rkmdrzj0jfzvc',
  'cmws1gvag0017t8vn2tvocus2','cmws1gvdn001dt8vnowuq47lj','cmws1gvgd001jt8vns1p9swlz','cmu8pydjl002zccg6sfla892k','cmu8pydjq0063ccg6rmc3lvav')
  AND status = 'LOSS'
UNION ALL
SELECT count(*) FROM picks WHERE id IN (
  'cmwp9496601nrtfzntvmtzjuv','cmwp949b901o2tfzn2kdx41hh','cmwp949fx01odtfznyejksxe5','cmwp9496601nqtfzn4tvyspjy','cmwp949b901o1tfznjjq4bg54','cmwp949fx01octfzn0uxs7f0o',
  'cmu8pydju008lccg6ewgjzg6h')
  AND status = 'WIN';
-- Expect 17 and 7.

-- COMMIT;
