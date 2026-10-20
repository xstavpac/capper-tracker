-- READ-ONLY. Every sport / betType / period / propMarket combination in picks, with
-- counts and the Parlay Generator category it lands in (betCategory,
-- src/lib/parlay/bet-category.ts - keyed on betType alone, period ignored).
-- Run in the Supabase SQL editor; it only SELECTs.
select s.name                                      as sport,
       p."betType"                                 as bet_type,
       p.period,
       coalesce(p."propMarket"::text, '-')         as prop_market,
       case p."betType"::text
         when 'MONEYLINE'   then 'Moneyline'
         when 'SPREAD'      then 'Spread'
         when 'TOTAL'       then 'Totals'
         when 'TEAM_TOTAL'  then 'Totals'
         when 'NRFI'        then 'Totals'
         when 'PLAYER_PROP' then 'Props'
         else 'UNCLASSIFIED'
       end                                         as generator_category,
       count(*)                                    as n,
       count(*) filter (where p.category is null)  as category_null,
       count(*) filter (where p.status = 'PENDING') as pending
from picks p
join sports s on s.id = p."sportId"
where s.name in ('NFL', 'NCAAF', 'MLB', 'NHL', 'NBA', 'WNBA')
group by 1, 2, 3, 4, 5
order by 1, 2, 3, 4;
