// Capper cleanup: junk cappers and name variants left by the automated ingest before the capper-name guard
// (lib/capper-name-guard.ts). For one source account and every account it delivers picks to (pick_recipients).
//
// THIS SCRIPT NEVER WRITES TO THE DATABASE. Modes:
//   --dry-run (default)   print the report: proposed MERGES, proposed DELETES, and NEEDS YOUR DECISION.
//   --emit-sql <file>     also write the cleanup as ONE BEGIN/COMMIT SQL script for a person to review and run in the
//                         Supabase SQL editor: backup tables first, then re-point rows by capper id, then guarded
//                         deletes by id (a delete only happens if the capper has no picks and no parlays left).
//                         Only MERGES and DELETES are emitted; NEEDS YOUR DECISION is never touched.
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
export type AccountPlan = { userId: string; email: string; isSource: boolean; cappers: number; merges: Merge[]; deletes: Junk[]; decide: Junk[] };

const activity = (c: CapperRow) => c.picks + c.parlays;

export function planAccount(rows: CapperRow[]): AccountPlan {
  const first = rows[0];
  const junk: Junk[] = [];
  const keep: CapperRow[] = [];
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
  merges.sort((a, b) => a.target.name.localeCompare(b.target.name) || a.stray.name.localeCompare(b.stray.name));
  return {
    userId: first.userId,
    email: first.email,
    isSource: first.isSource,
    cappers: rows.length,
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

const lit = (s: string) => "'" + s.replace(/'/g, "''") + "'";
const inList = (ids: string[]) => "(" + ids.map(lit).join(", ") + ")";

export function renderWriteSql(plans: AccountPlan[], stamp: string): string {
  const merges = plans.flatMap((a) => a.merges);
  const deletes = plans.flatMap((a) => a.deletes);
  const strayIds = merges.map((m) => m.stray.id);
  const capperIds = [...strayIds, ...merges.map((m) => m.target.id), ...deletes.map((d) => d.row.id)];
  const t = (name: string) => `capper_cleanup_${stamp}_${name}`;
  const s: string[] = [
    `-- Capper cleanup, generated ${new Date().toISOString()} by scripts/capper-cleanup.ts. Review before running.`,
    `-- ${merges.length} merges, ${deletes.length} deletes. Run as ONE transaction; any error rolls everything back.`,
    "BEGIN;",
    "",
    "-- 1. Backups of every row this script can change (kept after COMMIT; drop them once you're happy).",
    `CREATE TABLE ${t("cappers")} AS SELECT * FROM cappers WHERE id IN ${inList(capperIds.length ? capperIds : ["-"])};`,
    `CREATE TABLE ${t("picks")} AS SELECT * FROM picks WHERE "capperId" IN ${inList(strayIds.length ? strayIds : ["-"])};`,
    `CREATE TABLE ${t("parlay_bets")} AS SELECT * FROM parlay_bets WHERE "capperId" IN ${inList(strayIds.length ? strayIds : ["-"])};`,
    `CREATE TABLE ${t("dismissed_pairs")} AS SELECT * FROM dismissed_duplicate_pairs WHERE "capperAId" IN ${inList(capperIds.length ? capperIds : ["-"])} OR "capperBId" IN ${inList(capperIds.length ? capperIds : ["-"])};`,
    "",
    "-- 2. Merges: re-point picks and parlays to the target (same user only), carry the favorite flag, drop the stray's",
    "--    dismissed-duplicate pairs (moot once merged), then delete the stray only if nothing points at it any more.",
  ];
  for (const m of merges) {
    const [sid, tid, uid] = [lit(m.stray.id), lit(m.target.id), lit(m.userId)];
    s.push(
      `-- ${q(m.stray.name)} -> ${q(m.target.name)} (${m.stray.picks} picks, ${m.stray.parlays} parlays)`,
      `UPDATE picks SET "capperId" = ${tid} WHERE "capperId" = ${sid} AND "userId" = ${uid};`,
      `UPDATE parlay_bets SET "capperId" = ${tid} WHERE "capperId" = ${sid} AND "userId" = ${uid};`,
      ...(m.stray.isFavorite ? [`UPDATE cappers SET "isFavorite" = true WHERE id = ${tid} AND "userId" = ${uid};`] : []),
      `DELETE FROM dismissed_duplicate_pairs WHERE id IN (SELECT id FROM ${t("dismissed_pairs")} WHERE "capperAId" = ${sid} OR "capperBId" = ${sid});`,
      `DELETE FROM cappers WHERE id = ${sid} AND "userId" = ${uid} AND NOT EXISTS (SELECT 1 FROM picks WHERE "capperId" = ${sid}) AND NOT EXISTS (SELECT 1 FROM parlay_bets WHERE "capperId" = ${sid});`
    );
  }
  s.push("", "-- 3. Deletes: junk cappers with no picks and no parlays (re-checked here).");
  for (const d of deletes) {
    const [id, uid] = [lit(d.row.id), lit(d.row.userId)];
    s.push(
      `DELETE FROM cappers WHERE id = ${id} AND "userId" = ${uid} AND NOT EXISTS (SELECT 1 FROM picks WHERE "capperId" = ${id}) AND NOT EXISTS (SELECT 1 FROM parlay_bets WHERE "capperId" = ${id}); -- ${q(d.row.name)}`
    );
  }
  s.push(
    "",
    "-- 4. Check before COMMIT: every stray / junk id should be gone (expect 0).",
    `SELECT count(*) AS remaining FROM cappers WHERE id IN ${inList([...strayIds, ...deletes.map((d) => d.row.id)].length ? [...strayIds, ...deletes.map((d) => d.row.id)] : ["-"])};`,
    "COMMIT;"
  );
  return s.join("\n") + "\n";
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
  const email = arg("--email");
  const fromJson = arg("--from-json");
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
  const plans = planAll(rows);
  console.log(renderReport(plans, picks));
  const sqlOut = arg("--emit-sql");
  if (sqlOut) {
    writeFileSync(sqlOut, renderWriteSql(plans, new Date().toISOString().slice(0, 10).replace(/-/g, "")));
    console.log(`\nWrote the cleanup SQL (NOT run) to ${sqlOut}`);
  }
}

if (process.argv[1] && /capper-cleanup/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
