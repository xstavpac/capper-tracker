// Capper cleanup: junk cappers and name variants left by the automated ingest before the capper-name guard
// (lib/capper-name-guard.ts). For one source account and every account it delivers picks to (pick_recipients).
//
// THIS SCRIPT NEVER WRITES TO THE DATABASE. Modes:
//   --dry-run (default)   print the report: proposed MERGES, proposed DELETES, and NEEDS YOUR DECISION.
//   --emit-sql <file>     also write the cleanup as ONE BEGIN/COMMIT SQL script for a person to review and run in the
//                         Supabase SQL editor: backups first (own schema, RLS on), then moves, then guarded deletes by
//                         id. Needs real capper ids: --lookup-sql prints a read-only query that returns them, and
//                         --ids-json <file> takes its result. --preview-sql / --missing-sql print read-only SELECTs
//                         (per-account counts / copies with no target capper); --verify-sql prints the after-check.
//                         Decisions baked in (account owner, 2026-11-24): see APPROVED_ALIASES and the PURGE rule below.
//   --print-sql           print the two read-only queries (snapshot, then junk cappers' picks) and exit.
//
// Input, read-only either way:
//   DATABASE_URL set      the two reads run through Prisma.
//   --from-json <a.json> [--picks-json <b.json>]
//                         the JSON rows of the --print-sql queries, run elsewhere (e.g. the Supabase SQL editor), so no
//                         production credential has to be on this machine. Without --picks-json the junk cappers'
//                         picks are not listed; the report prints the ids to fetch them with.
//
//   npx tsx scripts/capper-cleanup.ts --email you@example.com [--from-json snap.json --picks-json picks.json]
//
// Every table that references a capper (checked against pg_constraint on 2026-11-24):
//   picks."capperId", parlay_bets."capperId", dismissed_duplicate_pairs."capperAId"/"capperBId" - all FK ON DELETE
//   CASCADE, so a capper is only ever deleted after its rows are re-pointed (and the delete re-checks that).
//   By name, no FK: ingest_review_items."capperName" (PENDING items are counted and reported, not rewritten),
//   import_skipped_lines."capperName" (a log, left as is), capper_name_decisions (keys, left as is).
//   Favorites: cappers."isFavorite" - a merge keeps the target a favorite if either was.
//   Recipient links: pick_recipients is per user, not per capper; copies point to their source pick by
//   picks."sourcePickId", which a capper merge does not change.
import { readFileSync, writeFileSync } from "node:fs";
import { capperNameJunkReason, findCapperVariant, type CapperJunkReason } from "../src/lib/capper-name-guard";
import { findPluralOnlyMatch, normalizeName, type StoredCapperNameDecision } from "../src/lib/fuzzy-match";

// ---- the reads ----

export const SNAPSHOT_SQL = `
WITH src AS (SELECT id FROM users WHERE lower(email) = lower($1)),
acct AS (SELECT id FROM src UNION SELECT "recipientUserId" FROM pick_recipients WHERE "sourceUserId" IN (SELECT id FROM src)),
roster AS (
  SELECT DISTINCT regexp_replace(lower("fullName"), '[^a-z0-9]', '', 'g') AS k FROM (
    SELECT "fullName" FROM nba_roster_players UNION ALL SELECT "fullName" FROM nhl_roster_players
    UNION ALL SELECT "fullName" FROM nfl_roster_players UNION ALL SELECT "fullName" FROM mlb_roster_players) r)
SELECT u.id AS "userId", u.email, (u.id IN (SELECT id FROM src)) AS "isSource",
  c.id, c.name, c."isFavorite", c."isTest", c."createdAt",
  (SELECT count(*)::int FROM picks p WHERE p."capperId" = c.id) AS picks,
  (SELECT count(*)::int FROM parlay_bets b WHERE b."capperId" = c.id) AS parlays,
  (SELECT count(*)::int FROM dismissed_duplicate_pairs d WHERE d."capperAId" = c.id OR d."capperBId" = c.id) AS "dismissedPairs",
  (SELECT count(*)::int FROM ingest_review_items i
     WHERE i."userId" = c."userId" AND i.status = 'PENDING' AND lower(btrim(i."capperName")) = lower(btrim(c.name))) AS "pendingReviewItems",
  (regexp_replace(lower(c.name), '[^a-z0-9]', '', 'g') IN (SELECT k FROM roster)) AS "rosterPlayer",
  COALESCE((SELECT json_agg(json_build_object('rawKey', d."rawKey", 'suggestedKey', d."suggestedKey", 'decision', d.decision))
     FROM capper_name_decisions d WHERE d."userId" = c."userId" AND d."rawKey" = regexp_replace(lower(c.name), '[^a-z0-9]', '', 'g')), '[]') AS decisions
FROM cappers c JOIN users u ON u.id = c."userId"
WHERE c."userId" IN (SELECT id FROM acct)
ORDER BY u.email, c.name`;

export const PICKS_SQL = `
SELECT 'pick' AS kind, p.id, p."capperId", p."betDetail" AS text, s.name AS sport, p."awayTeam", p."homeTeam",
  p."gameTime" AS "gameTime", p."createdAt", p.status::text AS status, p."isRecipientCopy"
FROM picks p LEFT JOIN sports s ON s.id = p."sportId" WHERE p."capperId" = ANY($1)
UNION ALL
SELECT 'parlay', b.id, b."capperId",
  (SELECT string_agg(COALESCE(l."betDetail", l."awayTeam" || ' @ ' || l."homeTeam"), ' | ') FROM legs l WHERE l."parlayBetId" = b.id),
  NULL, NULL, NULL, NULL, b."datePosted", b.status::text, false
FROM parlay_bets b WHERE b."capperId" = ANY($1)
ORDER BY 3, 9`;

export type CapperRow = {
  userId: string;
  email: string;
  isSource: boolean;
  id: string;
  name: string;
  isFavorite: boolean;
  isTest: boolean;
  createdAt: string;
  picks: number;
  parlays: number;
  dismissedPairs: number;
  pendingReviewItems: number;
  rosterPlayer: boolean;
  decisions: StoredCapperNameDecision[];
};

export type PickRow = {
  kind: "pick" | "parlay";
  id: string;
  capperId: string;
  text: string | null;
  sport: string | null;
  awayTeam: string | null;
  homeTeam: string | null;
  gameTime: string | null;
  createdAt: string;
  status: string;
  isRecipientCopy: boolean;
};

// ---- the plan (pure) ----

export type Merge = { userId: string; stray: CapperRow; target: CapperRow; why: string };
export type Junk = { row: CapperRow; reason: CapperJunkReason };
export type AccountPlan = {
  userId: string;
  email: string;
  isSource: boolean;
  cappers: number;
  merges: Merge[];
  deletes: Junk[];
  decide: Junk[];
  // An approved alias whose target capper does not exist in this account (nothing is created; listed for a person).
  missingTargets: string[];
};

// Decisions given by the account owner on 2026-11-24 (not guesses): a name that IS a real capper although it looks like
// a roster player. Normalized stray name -> the saved capper it files under. Never created: a missing target is listed.
const APPROVED_ALIASES: Record<string, string> = { [normalizeName("Alex Caruso")]: "Caruso" };
// A different person who must never be merged into, or out of, anything (e.g. "Prop Bet Guy Doug" is NOT "Doug").
const PROTECTED_NAMES = new Set([normalizeName("Doug")]);

const activity = (c: CapperRow) => c.picks + c.parlays;

export function planAccount(allRows: CapperRow[]): AccountPlan {
  const first = allRows[0];
  const junk: Junk[] = [];
  const keep: CapperRow[] = [];
  const aliasMerges: Merge[] = [];
  const missingTargets: string[] = [];
  // Approved aliases first: they are merges, not junk, and their target is whatever saved capper has the target name.
  const rows: CapperRow[] = [];
  for (const r of allRows) {
    const targetName = APPROVED_ALIASES[normalizeName(r.name)];
    if (!targetName) {
      rows.push(r);
      continue;
    }
    const target = allRows.find((x) => x.id !== r.id && normalizeName(x.name) === normalizeName(targetName));
    if (target) aliasMerges.push({ userId: r.userId, stray: r, target, why: "approved alias (" + r.name + " is " + target.name + ")" });
    else missingTargets.push(r.name + " -> " + targetName);
  }
  for (const r of rows) {
    const reason = r.rosterPlayer ? "player" : capperNameJunkReason(r.name);
    if (reason) junk.push({ row: r, reason });
    else keep.push(r);
  }

  // Variant pairs among the real-looking names, grouped (union-find); each group merges into its busiest capper.
  const parent = new Map(keep.map((r) => [r.id, r.id]));
  const find = (id: string): string => (parent.get(id) === id ? id : find(parent.get(id)!));
  const why = new Map<string, string>();
  for (const r of keep) {
    const others = keep.filter((o) => o.id !== r.id);
    const exact = others.find((o) => normalizeName(o.name) !== "" && normalizeName(o.name) === normalizeName(r.name));
    const names = others.map((o) => o.name);
    const variant = exact ? exact.name : findCapperVariant(r.name, names, r.decisions);
    // The import already files a name that differs from one saved capper only by one "s" (fuzzy-match.ts).
    const plural = variant ? null : findPluralOnlyMatch(r.name, names);
    const hit = variant ?? plural;
    if (!hit) continue;
    const o = others.find((x) => x.name === hit)!;
    parent.set(find(r.id), find(o.id));
    why.set(r.id, exact ? "same name apart from case/spacing/punctuation" : plural ? `one "s" apart from "${o.name}"` : `variant of "${o.name}"`);
  }
  const groups = new Map<string, CapperRow[]>();
  for (const r of keep) {
    const root = find(r.id);
    groups.set(root, [...(groups.get(root) ?? []), r]);
  }
  const merges: Merge[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const target = [...g].sort((a, b) => activity(b) - activity(a) || a.createdAt.localeCompare(b.createdAt))[0];
    for (const s of g) {
      if (s.id === target.id) continue;
      merges.push({ userId: s.userId, stray: s, target, why: why.get(s.id) ?? `variant of "${target.name}"` });
    }
  }
  merges.push(...aliasMerges);
  merges.sort((a, b) => a.target.name.localeCompare(b.target.name) || a.stray.name.localeCompare(b.stray.name));
  const touchesProtected = (r: CapperRow) => PROTECTED_NAMES.has(normalizeName(r.name));
  const bad = [...merges.flatMap((m) => [m.stray, m.target]), ...junk.map((j) => j.row)].filter(touchesProtected);
  if (bad.length) throw new Error("A protected capper would be touched: " + bad.map((b) => b.name).join(", "));
  return {
    userId: first.userId,
    email: first.email,
    isSource: first.isSource,
    cappers: allRows.length,
    missingTargets,
    merges,
    deletes: junk.filter((j) => activity(j.row) === 0).sort((a, b) => a.row.name.localeCompare(b.row.name)),
    decide: junk.filter((j) => activity(j.row) > 0).sort((a, b) => activity(b.row) - activity(a.row)),
  };
}

export function planAll(rows: CapperRow[]): AccountPlan[] {
  const byUser = new Map<string, CapperRow[]>();
  for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
  return [...byUser.values()].map(planAccount).sort((a, b) => Number(b.isSource) - Number(a.isSource) || a.email.localeCompare(b.email));
}

// ---- the report ----

const q = (s: string) => JSON.stringify(s);
const day = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : "-");

export function renderReport(plans: AccountPlan[], picks: PickRow[] | null): string {
  const out: string[] = [];
  const byCapper = new Map<string, PickRow[]>();
  for (const p of picks ?? []) byCapper.set(p.capperId, [...(byCapper.get(p.capperId) ?? []), p]);
  out.push("CAPPER CLEANUP - DRY RUN (read-only; nothing was written)");
  for (const a of plans) {
    out.push("", "=".repeat(100), `${a.email}  (${a.userId})  ${a.isSource ? "SOURCE ACCOUNT" : "PICK RECIPIENT"}  - ${a.cappers} cappers`, "=".repeat(100));

    const moved = a.merges.reduce((n, m) => n + m.stray.picks, 0);
    const movedParlays = a.merges.reduce((n, m) => n + m.stray.parlays, 0);
    out.push("", `1. PROPOSED MERGES (${a.merges.length}): stray -> target; moves ${moved} picks, ${movedParlays} parlays`);
    if (a.merges.length === 0) out.push("   (none)");
    for (const m of a.merges) {
      const extra = [
        m.stray.dismissedPairs ? `${m.stray.dismissedPairs} dismissed-duplicate pair(s) dropped` : "",
        m.stray.pendingReviewItems ? `${m.stray.pendingReviewItems} PENDING review item(s) under this name` : "",
        m.stray.isFavorite && !m.target.isFavorite ? "favorite flag carried to target" : "",
      ].filter(Boolean);
      out.push(
        `   ${q(m.stray.name)} -> ${q(m.target.name)}   picks ${m.stray.picks}, parlays ${m.stray.parlays}   [${m.why}; target has ${m.target.picks} picks, ${m.target.parlays} parlays]` +
          (extra.length ? `\n      ${extra.join("; ")}` : "")
      );
    }

    out.push("", `2. PROPOSED DELETES (${a.deletes.length}): junk names with 0 picks and 0 parlays`);
    if (a.deletes.length === 0) out.push("   (none)");
    for (const d of a.deletes) out.push(`   ${q(d.row.name)}  [${d.reason}]  id ${d.row.id}${d.row.pendingReviewItems ? `  (${d.row.pendingReviewItems} PENDING review items)` : ""}`);

    const n = a.decide.reduce((s, d) => s + activity(d.row), 0);
    out.push("", `3. NEEDS YOUR DECISION (${a.decide.length} cappers, ${n} picks/parlays): junk names that DO have picks`);
    if (a.decide.length === 0) out.push("   (none)");
    for (const d of a.decide) {
      out.push(`   ${q(d.row.name)}  [${d.reason}]  id ${d.row.id}  - ${d.row.picks} picks, ${d.row.parlays} parlays`);
      const rows = byCapper.get(d.row.id);
      if (!picks) continue;
      for (const p of rows ?? []) {
        const game = p.awayTeam && p.homeTeam ? `  (${p.awayTeam} @ ${p.homeTeam}, ${day(p.gameTime)})` : "";
        out.push(`      - ${p.kind === "parlay" ? "PARLAY " : ""}${q(p.text ?? "")}  ${p.sport ?? ""}  logged ${day(p.createdAt)}  ${p.status}${p.isRecipientCopy ? "  copy" : ""}${game}`);
      }
    }
  }
  if (!picks) out.push("", "(Pick lines not listed: run PICKS_SQL with these capper ids and pass --picks-json.)", JSON.stringify(plans.flatMap((a) => a.decide.map((d) => d.row.id))));
  out.push("", "Note: picks store no raw message line; the text shown is the pick's betDetail (what the import read).");
  return out.join("\n");
}

// ---- the write SQL (emitted only, never run here) ----
//
// Decisions behind it (account owner, 2026-11-24):
//   MERGE    a stray capper into a saved one: its picks and parlays move, then the stray is deleted.
//   PURGE    (source account) a junk capper WITH picks: its picks/parlays are deleted, then the capper.
//   DELETE0  (source account) a junk capper with no picks and no parlays: deleted.
//   RJUNK    (recipient accounts) a junk capper. Its copies follow their source pick (below); it is deleted if that leaves it empty.
// Recipient copies follow their source pick (picks."sourcePickId", no FK):
//   - the source pick is being deleted (PURGE), or is already gone and the copy sits under an RJUNK capper -> the copy is deleted;
//   - otherwise the copy is filed under the recipient's capper with the same (normalized) name as the capper the source pick
//     ends up under. No such capper (or two): the copy is left and listed - a capper is never created here.

const lit = (s: string) => "'" + s.replace(/'/g, "''") + "'";

export type PlanKind = "MERGE" | "PURGE" | "DELETE0" | "RJUNK";
export type PlanRow = { kind: PlanKind; userId: string; id: string; name: string; targetId: string | null; targetName: string | null };

export function planRows(plans: AccountPlan[]): PlanRow[] {
  const out: PlanRow[] = [];
  for (const a of plans) {
    for (const m of a.merges) out.push({ kind: "MERGE", userId: a.userId, id: m.stray.id, name: m.stray.name, targetId: m.target.id, targetName: m.target.name });
    for (const d of a.deletes) out.push({ kind: a.isSource ? "DELETE0" : "RJUNK", userId: a.userId, id: d.row.id, name: d.row.name, targetId: null, targetName: null });
    for (const d of a.decide) out.push({ kind: a.isSource ? "PURGE" : "RJUNK", userId: a.userId, id: d.row.id, name: d.row.name, targetId: null, targetName: null });
  }
  return out;
}

const KEY = (col: string) => `regexp_replace(lower(${col}), '[^a-z0-9]', '', 'g')`;
const ASCII = (col: string) => `regexp_replace(lower(btrim(${col})), '[^ -~]', '', 'g')`;
const JUNK_KINDS = `('PURGE', 'DELETE0', 'RJUNK')`;

// `t` prefixes the set tables ("" for a read-only preview that defines them as CTEs, "<schema>." in the transaction).
function copyDeleteSelect(t: string): string {
  return `SELECT c.id, c."userId", c."capperId" AS "fromCapperId",
       CASE WHEN s.id IS NULL THEN 'source pick already deleted' ELSE 'source pick is being deleted' END AS why
FROM picks c LEFT JOIN picks s ON s.id = c."sourcePickId"
WHERE c."isRecipientCopy" AND c."userId" IN (SELECT "userId" FROM ${t}acct WHERE role = 'RECIPIENT')
  AND ((s.id IS NOT NULL AND s."capperId" IN (SELECT id FROM ${t}plan WHERE kind = 'PURGE'))
    OR (s.id IS NULL AND c."capperId" IN (SELECT id FROM ${t}plan WHERE kind = 'RJUNK')))`;
}

// The capper a copy's source pick ends up under: its own capper, or the target when that capper is merged away.
function sourceFinalFrom(t: string): string {
  return `FROM picks c
JOIN picks s ON s.id = c."sourcePickId"
JOIN cappers sc ON sc.id = s."capperId"
LEFT JOIN ${t}plan sm ON sm.kind = 'MERGE' AND sm.id = sc.id
JOIN cappers fc ON fc.id = COALESCE(sm."targetId", sc.id)`;
}

function copyRefileSelect(t: string): string {
  return `SELECT c.id, c."userId", c."capperId" AS "fromCapperId", COALESCE(rm."targetId", rc.id) AS "toCapperId", fc.name AS "fileAs"
${sourceFinalFrom(t)}
JOIN cappers rc ON rc."userId" = c."userId" AND ${KEY("rc.name")} = ${KEY("fc.name")} AND ${KEY("fc.name")} <> ''
LEFT JOIN ${t}plan rm ON rm.kind = 'MERGE' AND rm.id = rc.id
WHERE c."isRecipientCopy" AND c."userId" IN (SELECT "userId" FROM ${t}acct WHERE role = 'RECIPIENT')
  AND c.id NOT IN (SELECT id FROM ${t}copy_delete)
  AND rc.id NOT IN (SELECT id FROM ${t}plan WHERE kind IN ${JUNK_KINDS})
  AND COALESCE(rm."targetId", rc.id) <> c."capperId"
  AND (SELECT count(*) FROM cappers x WHERE x."userId" = c."userId" AND x.id NOT IN (SELECT id FROM ${t}plan WHERE kind IN ${JUNK_KINDS})
         AND ${KEY("x.name")} = ${KEY("fc.name")}) = 1`;
}

function valuesSql(rows: (string | null)[][]): string {
  return rows.map((r) => "(" + r.map((v) => (v === null ? "NULL::text" : lit(v))).join(", ") + ")").join(",\n  ");
}
const planValues = (rows: PlanRow[]) => valuesSql(rows.map((r) => [r.kind, r.userId, r.id, r.name, r.targetId, r.targetName]));
const acctValues = (plans: AccountPlan[]) => valuesSql(plans.map((a) => [a.userId, a.isSource ? "SOURCE" : "RECIPIENT", a.email]));

function assertRealIds(rows: PlanRow[]) {
  const bad = rows.flatMap((r) => [r.id, r.targetId ?? ""]).filter((id) => id !== "" && /^\(id/.test(id));
  if (bad.length) throw new Error("capper ids not looked up yet (--lookup-sql, then --ids-json): " + bad.slice(0, 3).join(", "));
}

// Read-only: what the transaction would do, per account. Only SELECTs; safe to run anywhere.
export function renderPreviewSql(plans: AccountPlan[]): string {
  const rows = planRows(plans);
  assertRealIds(rows);
  return `WITH plan(kind, "userId", id, name, "targetId", "targetName") AS (VALUES
  ${planValues(rows)}),
acct("userId", role, email) AS (VALUES
  ${acctValues(plans)}),
copy_delete AS (${copyDeleteSelect("")}),
copy_refile AS (${copyRefileSelect("")}),
purge_picks AS (SELECT p.id, p."userId" FROM picks p WHERE p."capperId" IN (SELECT id FROM plan WHERE kind = 'PURGE'))
SELECT a.email, a.role,
  (SELECT count(*) FROM plan WHERE kind = 'MERGE' AND "userId" = a."userId") AS merges,
  (SELECT count(*) FROM picks p JOIN plan m ON m.kind = 'MERGE' AND m.id = p."capperId" WHERE p."userId" = a."userId"
     AND p.id NOT IN (SELECT id FROM copy_delete) AND p.id NOT IN (SELECT id FROM copy_refile)) AS picks_moved_by_merge,
  (SELECT count(*) FROM copy_refile r WHERE r."userId" = a."userId") AS copies_refiled,
  (SELECT count(*) FROM purge_picks x WHERE x."userId" = a."userId") AS source_picks_deleted,
  (SELECT count(*) FROM copy_delete d WHERE d."userId" = a."userId") AS copies_deleted,
  (SELECT count(*) FROM plan WHERE kind = 'MERGE' AND "userId" = a."userId") AS strays_deleted,
  (SELECT count(*) FROM plan WHERE kind IN ${JUNK_KINDS} AND "userId" = a."userId") AS junk_cappers_listed,
  (SELECT count(*) FROM plan pl WHERE pl.kind IN ${JUNK_KINDS} AND pl."userId" = a."userId"
     AND EXISTS (SELECT 1 FROM picks p WHERE p."capperId" = pl.id AND p.id NOT IN (SELECT id FROM copy_delete) AND p.id NOT IN (SELECT id FROM copy_refile) AND p.id NOT IN (SELECT id FROM purge_picks))) AS junk_cappers_left_with_picks,
  (SELECT count(*) FROM picks c WHERE c."userId" = a."userId" AND a.role = 'RECIPIENT' AND c."isRecipientCopy" AND c.id NOT IN (SELECT id FROM copy_delete)
     AND NOT EXISTS (SELECT 1 FROM picks s WHERE s.id = c."sourcePickId")) AS copies_with_missing_source_left
FROM acct a ORDER BY a.role DESC, a.email`;
}

// Read-only: copies that should move but have no (or two) matching capper on the recipient. Nothing is created for them.
export function renderMissingTargetsSql(plans: AccountPlan[]): string {
  const rows = planRows(plans);
  assertRealIds(rows);
  return `WITH plan(kind, "userId", id, name, "targetId", "targetName") AS (VALUES
  ${planValues(rows)}),
acct("userId", role, email) AS (VALUES
  ${acctValues(plans)}),
copy_delete AS (${copyDeleteSelect("")})
SELECT a.email, fc.name AS source_capper, count(*) AS copies,
  (SELECT count(*) FROM cappers x WHERE x."userId" = c."userId" AND x.id NOT IN (SELECT id FROM plan WHERE kind IN ${JUNK_KINDS}) AND ${KEY("x.name")} = ${KEY("fc.name")}) AS matching_cappers
${sourceFinalFrom("")}
JOIN acct a ON a."userId" = c."userId" AND a.role = 'RECIPIENT'
WHERE c."isRecipientCopy" AND c.id NOT IN (SELECT id FROM copy_delete)
  AND (SELECT count(*) FROM cappers x WHERE x."userId" = c."userId" AND x.id NOT IN (SELECT id FROM plan WHERE kind IN ${JUNK_KINDS}) AND ${KEY("x.name")} = ${KEY("fc.name")}) <> 1
GROUP BY a.email, fc.name, c."userId" ORDER BY 1, 3 DESC`;
}

// Read-only: the lookup that gives every capper in the plan its real id (ASCII names; the emoji names are given by hand).
export function renderLookupSql(plans: AccountPlan[], emailOf: (userId: string) => string): string {
  const seen = new Set<string>();
  const vals: string[][] = [];
  for (const r of planRows(plans)) {
    for (const name of [r.name, r.targetName]) {
      if (!name || /[^ -~]/.test(name)) continue;
      const k = emailOf(r.userId) + "\u0000" + name;
      if (seen.has(k)) continue;
      seen.add(k);
      vals.push([emailOf(r.userId), name]);
    }
  }
  return `SELECT json_agg(json_build_array(v.email, v.name, c.id) ORDER BY v.email, v.name) AS ids
FROM (VALUES
  ${valuesSql(vals)}) v(email, name)
JOIN users u ON lower(u.email) = lower(v.email)
LEFT JOIN cappers c ON c."userId" = u.id AND lower(btrim(c.name)) = lower(btrim(v.name))`;
}

export function renderWriteSql(plans: AccountPlan[], stamp: string): string {
  const rows = planRows(plans);
  assertRealIds(rows);
  const S = `cc_${stamp}`;
  const t = `${S}.`;
  const backups = ["plan", "acct", "copy_delete", "copy_refile", "purge_picks", "b_cappers", "b_picks", "b_parlay_bets", "b_legs", "b_pairs"];
  const merges = rows.filter((r) => r.kind === "MERGE").length;
  const count = (k: PlanKind) => rows.filter((r) => r.kind === k).length;
  return `-- Capper cleanup, generated ${new Date().toISOString()} by scripts/capper-cleanup.ts.
-- ONE transaction: any error (including a failed safety check) rolls everything back and changes nothing.
-- It backs up every row it can change into schema ${S} first (kept after COMMIT, RLS on, readable only by the DB owner),
-- moves rows before deleting anything, and every delete filters by id (ids captured into ${S}.* tables first).
-- ${merges} merges, ${count("PURGE")} purged cappers, ${count("DELETE0")} zero-pick deletes, ${count("RJUNK")} recipient junk cappers.
BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '300s';
CREATE SCHEMA ${S};

-- 0. The plan. The ids were looked up read-only; the checks below abort if any id / user / name does not match the database.
CREATE TABLE ${t}acct ("userId" text PRIMARY KEY, role text NOT NULL, email text NOT NULL);
INSERT INTO ${t}acct VALUES
  ${acctValues(plans)};
CREATE TABLE ${t}plan (kind text NOT NULL, "userId" text NOT NULL, id text PRIMARY KEY, name text NOT NULL, "targetId" text, "targetName" text);
INSERT INTO ${t}plan VALUES
  ${planValues(rows)};
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM ${t}plan p LEFT JOIN cappers c ON c.id = p.id AND c."userId" = p."userId" AND ${ASCII("c.name")} = ${ASCII("p.name")} WHERE c.id IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'plan: % capper rows do not match the database (id / user / name)', bad; END IF;
  SELECT count(*) INTO bad FROM ${t}plan p LEFT JOIN cappers c ON c.id = p."targetId" AND c."userId" = p."userId" AND ${ASCII("c.name")} = ${ASCII('p."targetName"')} WHERE p."targetId" IS NOT NULL AND c.id IS NULL;
  IF bad > 0 THEN RAISE EXCEPTION 'plan: % merge targets do not match the database (id / user / name)', bad; END IF;
  SELECT count(*) INTO bad FROM ${t}plan p JOIN ${t}acct a ON a."userId" = p."userId" WHERE (p.kind IN ('PURGE', 'DELETE0') AND a.role <> 'SOURCE') OR (p.kind = 'RJUNK' AND a.role <> 'RECIPIENT');
  IF bad > 0 THEN RAISE EXCEPTION 'plan: % rows are in the wrong kind of account', bad; END IF;
  SELECT count(*) INTO bad FROM ${t}plan p WHERE ${KEY("p.name")} = 'doug' OR ${KEY("coalesce(p.\"targetName\", '')")} = 'doug';
  IF bad > 0 THEN RAISE EXCEPTION 'plan: the separate Doug capper must not be touched'; END IF;
END $$;

-- 1. What will change, with ids captured NOW (every write below uses these tables, not names).
CREATE TABLE ${t}copy_delete AS
${copyDeleteSelect(t)};
CREATE TABLE ${t}copy_refile AS
${copyRefileSelect(t)};
CREATE TABLE ${t}purge_picks AS SELECT p.id, p."userId", p."capperId" FROM picks p WHERE p."capperId" IN (SELECT id FROM ${t}plan WHERE kind = 'PURGE');

-- 2. Backups of every row that can change.
CREATE TABLE ${t}b_cappers AS SELECT * FROM cappers WHERE id IN (SELECT id FROM ${t}plan UNION SELECT "targetId" FROM ${t}plan WHERE "targetId" IS NOT NULL);
CREATE TABLE ${t}b_picks AS SELECT * FROM picks WHERE id IN (SELECT id FROM ${t}copy_delete UNION SELECT id FROM ${t}copy_refile UNION SELECT id FROM ${t}purge_picks)
  OR "capperId" IN (SELECT id FROM ${t}plan WHERE kind = 'MERGE');
CREATE TABLE ${t}b_parlay_bets AS SELECT * FROM parlay_bets WHERE "capperId" IN (SELECT id FROM ${t}plan);
CREATE TABLE ${t}b_legs AS SELECT * FROM legs WHERE "parlayBetId" IN (SELECT id FROM ${t}b_parlay_bets);
CREATE TABLE ${t}b_pairs AS SELECT * FROM dismissed_duplicate_pairs WHERE "capperAId" IN (SELECT id FROM ${t}plan) OR "capperBId" IN (SELECT id FROM ${t}plan);
${backups.map((b) => `ALTER TABLE ${t}${b} ENABLE ROW LEVEL SECURITY;`).join("\n")}

-- 3. Recipient copies follow their source pick.
DELETE FROM picks p USING ${t}copy_delete d WHERE p.id = d.id AND p."userId" = d."userId" AND p."isRecipientCopy";
UPDATE picks p SET "capperId" = r."toCapperId" FROM ${t}copy_refile r WHERE p.id = r.id AND p."userId" = r."userId" AND p."isRecipientCopy";

-- 4. Source account: the picks and parlays of the junk cappers you decided to purge (legs go with their parlay).
DELETE FROM picks p USING ${t}purge_picks x WHERE p.id = x.id AND p."userId" = x."userId";
DELETE FROM parlay_bets b USING ${t}b_parlay_bets x, ${t}plan pl WHERE b.id = x.id AND x."capperId" = pl.id AND pl.kind = 'PURGE';

-- 5. Merges, all accounts: move what is left on each stray to its target; a favorite stray makes the target a favorite.
UPDATE picks p SET "capperId" = m."targetId" FROM ${t}plan m WHERE m.kind = 'MERGE' AND p."capperId" = m.id AND p."userId" = m."userId";
UPDATE parlay_bets b SET "capperId" = m."targetId" FROM ${t}plan m WHERE m.kind = 'MERGE' AND b."capperId" = m.id AND b."userId" = m."userId";
UPDATE cappers t SET "isFavorite" = true FROM ${t}plan m JOIN cappers s ON s.id = m.id
  WHERE m.kind = 'MERGE' AND t.id = m."targetId" AND t."userId" = m."userId" AND s."isFavorite" AND NOT t."isFavorite";

-- 6. Delete the cappers, only those left with no picks and no parlays (dismissed-duplicate pairs cascade; backed up above).
DELETE FROM cappers c USING ${t}plan p
  WHERE c.id = p.id AND c."userId" = p."userId"
    AND NOT EXISTS (SELECT 1 FROM picks x WHERE x."capperId" = c.id)
    AND NOT EXISTS (SELECT 1 FROM parlay_bets x WHERE x."capperId" = c.id);

-- 7. Safety check: no merged-away, purged or zero-pick capper may remain (recipient junk that still holds its own picks may).
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM ${t}plan p JOIN cappers c ON c.id = p.id WHERE p.kind IN ('MERGE', 'PURGE', 'DELETE0');
  IF bad > 0 THEN RAISE EXCEPTION 'check failed: % merged/purged/zero-pick cappers still exist', bad; END IF;
END $$;
COMMIT;
`;
}

// Read-only, run AFTER the script: every line says what it wants.
export function renderVerifySql(stamp: string): string {
  const S = `cc_${stamp}.`;
  return `SELECT check_name, n FROM (
  SELECT 1 AS o, 'merged-away cappers still present (want 0)' AS check_name, count(*) AS n FROM ${S}plan p JOIN cappers c ON c.id = p.id WHERE p.kind = 'MERGE'
  UNION ALL SELECT 2, 'purged + zero-pick source cappers still present (want 0)', count(*) FROM ${S}plan p JOIN cappers c ON c.id = p.id WHERE p.kind IN ('PURGE', 'DELETE0')
  UNION ALL SELECT 3, 'recipient junk cappers still present (want 0; any left still hold their own non-copy picks)', count(*) FROM ${S}plan p JOIN cappers c ON c.id = p.id WHERE p.kind = 'RJUNK'
  UNION ALL SELECT 4, 'picks still on a merged-away or junk capper id (want 0)', count(*) FROM picks p WHERE p."capperId" IN (SELECT id FROM ${S}plan)
  UNION ALL SELECT 5, 'deleted copies still present (want 0)', count(*) FROM ${S}copy_delete d JOIN picks p ON p.id = d.id
  UNION ALL SELECT 6, 'purged source picks still present (want 0)', count(*) FROM ${S}purge_picks x JOIN picks p ON p.id = x.id
  UNION ALL SELECT 7, 'refiled copies not on their target capper (want 0)', count(*) FROM ${S}copy_refile r JOIN picks p ON p.id = r.id WHERE p."capperId" <> r."toCapperId"
  UNION ALL SELECT 8, 'Doug cappers across the 3 accounts (want 3, untouched)', count(*) FROM cappers c WHERE c."userId" IN (SELECT "userId" FROM ${S}acct) AND lower(btrim(c.name)) = 'doug'
  UNION ALL SELECT 9, 'copies filed under a capper whose name differs from their source pick capper (informational)', count(*)
    FROM picks c JOIN picks s ON s.id = c."sourcePickId" JOIN cappers sc ON sc.id = s."capperId" JOIN cappers rc ON rc.id = c."capperId"
    WHERE c."isRecipientCopy" AND c."userId" IN (SELECT "userId" FROM ${S}acct WHERE role = 'RECIPIENT')
      AND ${KEY("rc.name")} <> ${KEY("sc.name")}
  UNION ALL SELECT 10, 'recipient cappers with 0 picks and 0 parlays (informational; emptied by moving copies)', count(*)
    FROM cappers c WHERE c."userId" IN (SELECT "userId" FROM ${S}acct WHERE role = 'RECIPIENT')
      AND NOT EXISTS (SELECT 1 FROM picks x WHERE x."capperId" = c.id) AND NOT EXISTS (SELECT 1 FROM parlay_bets x WHERE x."capperId" = c.id)
  UNION ALL SELECT 11, 'pick rows backed up in ${S}b_picks', count(*) FROM ${S}b_picks
) r ORDER BY o`;
}

// ---- CLI ----

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (process.argv.includes("--write") || process.argv.includes("--apply")) {
    throw new Error("This script never writes. Use --emit-sql <file>, review the SQL, and run it in the Supabase SQL editor.");
  }
  if (process.argv.includes("--print-sql")) {
    console.log("-- snapshot ($1 = the source account's email)\n" + SNAPSHOT_SQL + ";\n\n-- junk cappers' picks ($1 = text[] of capper ids)\n" + PICKS_SQL + ";");
    return;
  }
  if (process.argv.includes("--verify-sql")) {
    console.log(renderVerifySql(arg("--stamp") ?? new Date().toISOString().slice(0, 10).replace(/-/g, "")));
    return;
  }
  const email = arg("--email");
  const fromJson = arg("--from-json");
  const idsJson = arg("--ids-json");
  const picksJson = arg("--picks-json");
  let rows: CapperRow[];
  let picks: PickRow[] | null = null;
  if (fromJson) {
    rows = JSON.parse(readFileSync(fromJson, "utf8"));
    if (picksJson) picks = JSON.parse(readFileSync(picksJson, "utf8"));
  } else {
    if (!email) throw new Error("--email <source account email> is required");
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    try {
      rows = await prisma.$queryRawUnsafe<CapperRow[]>(SNAPSHOT_SQL, email);
      const ids = planAll(rows).flatMap((a) => a.decide.map((d) => d.row.id));
      picks = ids.length ? await prisma.$queryRawUnsafe<PickRow[]>(PICKS_SQL, ids) : [];
    } finally {
      await prisma.$disconnect();
    }
  }
  if (rows.length === 0) throw new Error("No cappers found for that account.");
  rows = rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt).toISOString(), decisions: r.decisions ?? [] }));
  // Real capper ids from the read-only lookup: [[email, name, id], ...]. Any row not in it keeps its placeholder id.
  if (idsJson) {
    const found = new Map((JSON.parse(readFileSync(idsJson, "utf8")) as [string, string, string | null][]).map(([e, n, id]) => [e.toLowerCase() + "\u0000" + n.toLowerCase().trim(), id]));
    rows = rows.map((r) => ({ ...r, id: found.get(r.email.toLowerCase() + "\u0000" + r.name.toLowerCase().trim()) ?? r.id }));
  }
  const plans = planAll(rows);
  const emailOf = (userId: string) => rows.find((r) => r.userId === userId)!.email;
  const stamp = arg("--stamp") ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const only = (flag: string, render: () => string) => {
    if (!process.argv.includes(flag)) return false;
    console.log(render());
    return true;
  };
  if (only("--lookup-sql", () => renderLookupSql(plans, emailOf))) return;
  if (only("--preview-sql", () => renderPreviewSql(plans))) return;
  if (only("--missing-sql", () => renderMissingTargetsSql(plans))) return;
  console.log(renderReport(plans, picks));
  for (const a of plans) if (a.missingTargets.length) console.log(`\nMISSING TARGET in ${a.email}: ${a.missingTargets.join("; ")}`);
  const sqlOut = arg("--emit-sql");
  if (sqlOut) {
    writeFileSync(sqlOut, renderWriteSql(plans, stamp));
    console.log(`\nWrote the cleanup SQL (NOT run) to ${sqlOut}`);
  }
}

if (process.argv[1] && /capper-cleanup/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
