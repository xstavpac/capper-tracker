// The engine behind scripts/backfill-pick-category.ts --ml-side (PICK_CATEGORY_VERSION 4).
//
// Legacy full-game MONEYLINE picks with no stored mlFavoredSide were filed as
// FAV_ML or DOG_ML by the sign of their price - and every -110 placeholder as a
// favorite. This reads each one's game from the ledger grading already writes
// (GameResult.favTeam), stores the real favored side (and the picked side, where
// the pick predates that column and its text names exactly one team), and
// restamps its category from the real pickCategory(). A pick whose game can't be
// resolved is restamped from what it has: the forward rule returns no category
// for a DEFAULTED / legacy / -110 price, so it leaves the FAV_ML / DOG_ML records
// rather than be counted on a guess.
//
// DRY RUN BY DEFAULT. It writes only category, categoryVersion, mlFavoredSide and
// (only where it was null) pickedSide, by exact id, each guarded by
// categoryVersion < current AND mlFavoredSide IS NULL, so a re-run is a no-op and
// a pick stored in between is never overwritten. Storing pickedSide changes no
// grade: gradePick already read the same side from the text for a row without
// one, and the dry run regrades every such row both ways and refuses to apply if
// any outcome would differ.
import type { Prisma, PickedSide } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { LIVE_SPORTS } from "@/server/data/odds";
import { gradePick } from "@/server/data/grading";
import { pickCategory, PICK_CATEGORY_VERSION } from "@/server/data/stats";
import { resolveMlSides, type LedgerGame, type SideUnresolvedReason } from "@/server/data/ml-side-resolution";

const MS_DAY = 86_400_000;
const WRITE_CHUNK = 500;
const FAV_DOG = ["FAV_ML", "DOG_ML"] as const;

export type MlSideOptions = {
  apply: boolean;
  batchSize: number;
  // Restrict to one sport (Sport.name, e.g. "MLB"). Unset: every sport.
  sportName?: string;
  // Test seam: narrows which picks are read (the CLI passes none).
  scope?: Prisma.PickWhereInput;
  log?: (line: string) => void;
};

type Rec = { w: number; l: number; p: number };
const emptyRec = (): Rec => ({ w: 0, l: 0, p: 0 });
const addStatus = (r: Rec, status: string, delta: number) => {
  if (status === "WIN") r.w += delta;
  else if (status === "LOSS") r.l += delta;
  else if (status === "PUSH") r.p += delta;
};
const pct = (r: Rec) => (r.w + r.l > 0 ? ((100 * r.w) / (r.w + r.l)).toFixed(1) + "%" : "n/a");
const fmt = (r: Rec) => `${r.w}-${r.l}${r.p ? "-" + r.p : ""} (${pct(r)})`;

export type MlSideResult = {
  read: number;
  resolved: number;
  unresolved: Map<SideUnresolvedReason | "NO_SCORE_FEED", number>;
  // "<sport> <old> -> <new>" -> rows
  moves: Map<string, number>;
  // Rows that would be written (resolved, or category changes).
  toWrite: number;
  written: number;
  // Rows whose side is newly stored (pickedSide was null) and whose recomputed
  // grade differs from the grade the text-fallback gave. Must be 0 to apply.
  gradeChanges: number;
  // Rows whose recomputed grade differs from the stored status (informational:
  // manual grades, fuzzy-graded rows).
  gradeVsStatus: number;
  // Per sport: [before, after] FAV_ML / DOG_ML records over EVERY full-game ML pick.
  records: Map<string, { before: Record<"FAV_ML" | "DOG_ML", Rec>; after: Record<"FAV_ML" | "DOG_ML", Rec> }>;
  samples: string[];
};

type Row = {
  id: string;
  betType: "MONEYLINE";
  period: "FULL_GAME";
  betDetail: string | null;
  odds: number;
  oddsSource: "STATED" | "MARKET" | "DEFAULTED" | null;
  line: number | null;
  pickedSide: PickedSide | null;
  mlFavoredSide: PickedSide | null;
  propMarket: null;
  homeTeam: string;
  awayTeam: string;
  gameTime: Date;
  gameNumber: number | null;
  status: string;
  category: string | null;
  sport: { name: string };
};

export async function backfillMlSide(opts: MlSideOptions): Promise<MlSideResult> {
  const log = opts.log ?? (() => {});
  const where: Prisma.PickWhereInput = {
    ...(opts.scope ?? {}),
    betType: "MONEYLINE",
    period: "FULL_GAME",
    mlFavoredSide: null,
    category: { in: [...FAV_DOG] },
    categoryVersion: { lt: PICK_CATEGORY_VERSION },
    ...(opts.sportName ? { sport: { name: opts.sportName } } : {}),
  };

  // 1. The picks (keyset-paged by id, like the other engines).
  const rows: Row[] = [];
  let lastId: string | undefined;
  for (;;) {
    const batch = (await prisma.pick.findMany({
      where: lastId ? { AND: [where, { id: { gt: lastId } }] } : where,
      orderBy: { id: "asc" },
      take: opts.batchSize,
      select: {
        id: true,
        betType: true,
        period: true,
        betDetail: true,
        odds: true,
        oddsSource: true,
        line: true,
        pickedSide: true,
        mlFavoredSide: true,
        propMarket: true,
        homeTeam: true,
        awayTeam: true,
        gameTime: true,
        gameNumber: true,
        status: true,
        category: true,
        sport: { select: { name: true } },
      },
    })) as unknown as Row[];
    if (batch.length === 0) break;
    lastId = batch[batch.length - 1].id;
    rows.push(...batch);
    log(`  ...read ${rows.length} pick(s)`);
  }

  // 2. The ledger: one read per sport that has a score feed, over the picks' own
  // date range (matchGameResult looks +-2 days around each pick).
  const sportKeyByName = new Map(LIVE_SPORTS.map((s) => [s.label.toUpperCase(), s.key]));
  const ranges = new Map<string, { min: number; max: number }>();
  for (const r of rows) {
    const key = sportKeyByName.get(r.sport.name.toUpperCase());
    if (!key) continue;
    const t = r.gameTime.getTime();
    const cur = ranges.get(key);
    if (!cur) ranges.set(key, { min: t, max: t });
    else {
      cur.min = Math.min(cur.min, t);
      cur.max = Math.max(cur.max, t);
    }
  }
  const ledgerByKey = new Map<string, LedgerGame[]>();
  for (const [key, range] of ranges) {
    const games = await prisma.gameResult.findMany({
      where: { sportKey: key, gameDate: { gte: new Date(range.min - 2 * MS_DAY), lt: new Date(range.max + 2 * MS_DAY) } },
      select: { homeTeam: true, awayTeam: true, gameDate: true, gameNumber: true, homeScore: true, awayScore: true, favTeam: true },
    });
    ledgerByKey.set(key, games);
  }

  // 3. Decide every row.
  const result: MlSideResult = {
    read: rows.length,
    resolved: 0,
    unresolved: new Map(),
    moves: new Map(),
    toWrite: 0,
    written: 0,
    gradeChanges: 0,
    gradeVsStatus: 0,
    records: new Map(),
    samples: [],
  };
  type Write = { id: string; set: { pickedSide?: PickedSide; mlFavoredSide?: PickedSide; category: string | null } };
  const writes: Write[] = [];
  const delta = new Map<string, Record<"FAV_ML" | "DOG_ML", Rec>>(); // sport -> change from "before" to "after"
  const bump = <T,>(m: Map<T, number>, k: T) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const row of rows) {
    const sport = row.sport.name;
    const key = sportKeyByName.get(sport.toUpperCase());
    let pickedSide: PickedSide | null = row.pickedSide;
    let mlFavoredSide: PickedSide | null = null;
    let setPicked = false;

    if (!key) {
      bump(result.unresolved, "NO_SCORE_FEED");
    } else {
      const res = resolveMlSides(row, ledgerByKey.get(key) ?? [], key);
      if (!res.resolved) bump(result.unresolved, res.reason);
      else {
        result.resolved++;
        pickedSide = res.pickedSide;
        mlFavoredSide = res.mlFavoredSide;
        setPicked = res.pickedSideWasNull;
        if (setPicked) {
          // Grade parity: the stored side must grade exactly as the text fallback did.
          const detail = row.betDetail ?? row.homeTeam;
          const g = res.game;
          const before = gradePick("MONEYLINE", detail, row.line, g.homeTeam, g.awayTeam, g.homeScore, g.awayScore, null);
          const after = gradePick("MONEYLINE", detail, row.line, g.homeTeam, g.awayTeam, g.homeScore, g.awayScore, res.pickedSide);
          if (before !== after) {
            result.gradeChanges++;
            if (result.samples.length < 20) result.samples.push(`GRADE CHANGE ${row.id}: text-fallback ${before} -> stored side ${after}`);
          }
          if ((row.status === "WIN" || row.status === "LOSS" || row.status === "PUSH") && after !== row.status) result.gradeVsStatus++;
        }
      }
    }

    const category = pickCategory({ ...row, sportName: sport, pickedSide, mlFavoredSide });
    const move = `${sport} ${row.category} -> ${category ?? "(null)"}`;
    bump(result.moves, move);

    if (mlFavoredSide !== null || category !== row.category) {
      result.toWrite++;
      writes.push({
        id: row.id,
        set: {
          ...(setPicked && pickedSide ? { pickedSide } : {}),
          ...(mlFavoredSide ? { mlFavoredSide } : {}),
          category,
        },
      });
      if (result.samples.length < 20 && (mlFavoredSide !== null || category !== row.category)) {
        result.samples.push(`${row.id}: ${row.category} -> ${category ?? "(null)"} src=${row.oddsSource ?? "legacy"} odds=${row.odds}${mlFavoredSide ? " favored=" + mlFavoredSide : ""}`);
      }
    }

    // Records: this row leaves its old category and joins its new one.
    const d = delta.get(sport) ?? { FAV_ML: emptyRec(), DOG_ML: emptyRec() };
    if (row.category === "FAV_ML" || row.category === "DOG_ML") addStatus(d[row.category], row.status, -1);
    if (category === "FAV_ML" || category === "DOG_ML") addStatus(d[category], row.status, +1);
    delta.set(sport, d);
  }

  // 4. Before/after records over EVERY full-game ML pick of each sport touched
  // (a SQL aggregate, not a row read): already-correct picks are in both columns.
  for (const [sport, d] of delta) {
    const groups = await prisma.pick.groupBy({
      by: ["category", "status"],
      where: { sport: { name: sport }, betType: "MONEYLINE", period: "FULL_GAME", category: { in: [...FAV_DOG] }, ...(opts.scope ?? {}) },
      _count: { _all: true },
    });
    const before = { FAV_ML: emptyRec(), DOG_ML: emptyRec() };
    for (const g of groups) if (g.category === "FAV_ML" || g.category === "DOG_ML") addStatus(before[g.category], g.status, g._count._all);
    const after = {
      FAV_ML: { w: before.FAV_ML.w + d.FAV_ML.w, l: before.FAV_ML.l + d.FAV_ML.l, p: before.FAV_ML.p + d.FAV_ML.p },
      DOG_ML: { w: before.DOG_ML.w + d.DOG_ML.w, l: before.DOG_ML.l + d.DOG_ML.l, p: before.DOG_ML.p + d.DOG_ML.p },
    };
    result.records.set(sport, { before, after });
  }

  // 5. Report.
  log(`\nPicks read (full-game ML, no mlFavoredSide, FAV_ML/DOG_ML, below version ${PICK_CATEGORY_VERSION}): ${result.read}`);
  log(`  side resolved from the ledger: ${result.resolved}`);
  for (const [reason, n] of Array.from(result.unresolved.entries()).sort((a, b) => b[1] - a[1])) log(`  not resolved - ${reason}: ${n}`);
  log("\nCategory moves (sport old -> new):");
  for (const [m, n] of Array.from(result.moves.entries()).sort()) log(`  ${m.padEnd(34)} ${n}`);
  log("\nFAV_ML / DOG_ML records, all full-game moneyline picks (before -> after):");
  for (const [sport, r] of Array.from(result.records.entries()).sort()) {
    log(`  ${sport}  FAV_ML ${fmt(r.before.FAV_ML)} -> ${fmt(r.after.FAV_ML)}`);
    log(`  ${" ".repeat(sport.length)}  DOG_ML ${fmt(r.before.DOG_ML)} -> ${fmt(r.after.DOG_ML)}`);
  }
  log(`\nGrade parity for newly stored pickedSide: ${result.gradeChanges} outcome(s) would change (must be 0 to apply); ${result.gradeVsStatus} differ from the stored status (informational).`);
  log(`Rows ${opts.apply ? "to write" : "that would be written"}: ${result.toWrite} of ${result.read}.`);
  if (result.samples.length > 0) {
    log("\nSamples (up to 20):");
    for (const s of result.samples) log("  " + s);
  }

  if (!opts.apply) {
    log("\nDRY RUN - nothing written.");
    return result;
  }
  if (result.gradeChanges > 0) {
    throw new Error(`Refusing to apply: ${result.gradeChanges} pick(s) would grade differently with the stored side. Nothing was written.`);
  }

  // 6. Apply: grouped by what is written, each by exact id.
  const guard: Prisma.PickWhereInput = { mlFavoredSide: null, categoryVersion: { lt: PICK_CATEGORY_VERSION } };
  const groupsToWrite = new Map<string, { set: Write["set"]; ids: string[] }>();
  for (const w of writes) {
    const k = JSON.stringify(w.set);
    const g = groupsToWrite.get(k);
    if (g) g.ids.push(w.id);
    else groupsToWrite.set(k, { set: w.set, ids: [w.id] });
  }
  for (const { set, ids } of groupsToWrite.values()) {
    for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
      const { count } = await prisma.pick.updateMany({
        where: { id: { in: ids.slice(i, i + WRITE_CHUNK) }, ...guard, ...(set.pickedSide ? { pickedSide: null } : {}) },
        data: { ...set, categoryVersion: PICK_CATEGORY_VERSION },
      });
      result.written += count;
    }
  }
  log(`\nWrote ${result.written} row(s).`);
  return result;
}
