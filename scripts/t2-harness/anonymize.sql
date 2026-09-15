-- T2 harness: anonymization pass, applied to a STAGING database that already
-- holds a restored production dump (see extract-from-dump.mjs - this script
-- is never run against a live connection, only against a local restore).
--
-- ============================================================================
-- PII / sensitive-field inventory (from prisma/schema.prisma, read directly -
-- not from memory), scoped to the tables T2 actually needs: Cappers-page data
-- functions (src/server/data/cappers.ts) touch User, Capper, Subscription,
-- DismissedDuplicatePair, Pick, Sport, League. Sport/League/DismissedDuplicatePair
-- carry no sensitive fields of their own (Sport/League are pure reference data;
-- DismissedDuplicatePair is only FK columns) and are not listed below.
-- ============================================================================
--
-- users
--   id                  -- NOT transformed. See "Referential integrity" below.
--   supabaseId          -- PII (auth identifier)              -> synthetic, deterministic per id
--   email                -- PII (direct identifier, unique)    -> synthetic, deterministic per id
--   name                -- PII (direct identifier)             -> synthetic, deterministic per id
--   profilePictureUrl   -- PII (may be a real photo URL)       -> NULL
--
-- subscriptions
--   stripeCustomerId     -- PII/financial identifier            -> synthetic, deterministic per id
--   stripeSubscriptionId -- PII/financial identifier            -> synthetic, deterministic per id
--   stripePriceId        -- NOT PII (a fixed product/price id, not user-identifying) -> unchanged
--
-- cappers
--   id                  -- NOT transformed. See "Referential integrity" below.
--   name                -- third-party identifying handle/name (often a real
--                          person's name or social handle)      -> synthetic, deterministic per id
--   photoUrl             -- potentially identifying (real photo) -> NULL
--   customSource          -- free text, may contain a handle/URL -> NULL
--   notes                -- free text, arbitrary PII risk        -> NULL
--
-- picks
--   notes                -- free text, arbitrary PII risk        -> NULL
--
-- Explicitly considered and NOT transformed (flagging the decision, not
-- omitting it):
--   picks.betDetail, picks.playerName, picks.homeTeam, picks.awayTeam
--     -- may name a professional athlete or team - public sports data in this
--        betting context, not personal data about a private individual. Left
--        verbatim so category/specialist-tag classification (which reads
--        betDetail) behaves identically on the anonymized snapshot. Revisit
--        if this project's definition of "sensitive" should be stricter than
--        "identifies a private person."
--   subscriptions.plan/status/currentPeriodEnd/cancelAtPeriodEnd,
--   picks.* betting fields (odds/line/units/gameTime/datePosted/status/...)
--     -- business/betting data, not identifying on their own.
--
-- ============================================================================
-- Referential integrity
-- ============================================================================
-- Every id / foreign-key column (users.id, cappers.id, picks.userId,
-- picks.capperId, subscriptions.userId, dismissed_duplicate_pairs.*Id, ...)
-- is deliberately left UNTOUCHED by this script. cuids are already opaque,
-- non-identifying strings - remapping them would require rewriting every
-- referencing row across every table (picks, parlay_bets, legs,
-- dismissed_duplicate_pairs, subscriptions, ...) and risks a missed call site
-- silently breaking a join. Anonymizing only the human-readable attribute
-- columns (name/email/notes/photo/etc.), and never the key columns, makes
-- referential integrity hold by construction - there is nothing to keep
-- consistent because nothing that participates in a join or FK is ever
-- rewritten.
--
-- ============================================================================
-- Determinism
-- ============================================================================
-- Every synthetic value is derived from md5(<the row's own id>), so re-running
-- this script against the same source dump always produces the same
-- anonymized output (useful for diffing two anonymization runs against each
-- other) without ever needing to persist a mapping table.

-- ---- users ----
update users set
  "supabaseId" = 'anon-' || md5(id),
  email = 'user-' || substr(md5(id), 1, 12) || '@t2-anon.invalid',
  name = (array[
    'Alex Rivera','Jordan Lee','Sam Patel','Casey Morgan','Taylor Kim',
    'Drew Sullivan','Riley Cho','Jamie Ortiz','Morgan Ellis','Reese Novak'
  ])[1 + (('x' || substr(md5(id), 1, 8))::bit(32)::bigint % 10)],
  "profilePictureUrl" = null;

-- ---- subscriptions ----
update subscriptions set
  "stripeCustomerId" = case when "stripeCustomerId" is not null then 'cus_anon_' || substr(md5(id), 1, 14) end,
  "stripeSubscriptionId" = case when "stripeSubscriptionId" is not null then 'sub_anon_' || substr(md5(id), 1, 14) end;

-- ---- cappers ----
update cappers set
  name = (array[
    'Sharp Shooter','Vegas Vic','Lucky Lefty','Prime Time Picks','The Closer',
    'Cold Streak Carl','Fade Master','Midnight Money','Big Board Betty','Grinder Gus',
    'Third Quarter Tony','Overtime Oscar','Chalk Eater','Dog Day Dana','Line Mover Leo'
  ])[1 + (('x' || substr(md5(id), 1, 8))::bit(32)::bigint % 15)],
  "photoUrl" = null,
  "customSource" = case when "customSource" is not null then 'anon-source' end,
  notes = null;

-- ---- picks ----
update picks set
  notes = null
where notes is not null;
