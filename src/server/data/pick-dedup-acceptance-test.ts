// Server-side duplicate check (pick-dedup.ts): the server, not the review
// screen, decides whether a pick is inserted.
//
// Real-database test (no spies), run with DATABASE_URL set:
//   npx tsx src/server/data/pick-dedup-acceptance-test.ts
// Exits non-zero on any failed assertion.
//
// Every scenario is run twice:
//   LEGACY - the code this replaced, so the bug is reproduced, not assumed:
//     * legacyImport = createPicksWithEntitlementCheck, which is all
//       bulkImportPicksAction and createPick did - insert whatever arrives.
//     * legacyDbDuplicateLabel = the previous matcher, copied verbatim (exact
//       homeTeam/awayTeam strings, FAV_ML/DOG_ML category).
//   NEW - insertPicksDeduped.
// A "LEGACY reproduces" line PASSES when the old code does the wrong thing.
//
// The fixtures are the production reports: Bullies PICKS "Wyoming +10.5"
// stored twice, PARLAY SAFARI "Liberty 1H -7" / "Liberty 1st Half -7", and the
// Liberty @ Dream paste (Ben Burns, KIMSPICKS, RHINO, Vinny) imported at 20:44
// and again at 21:54. Opponents and prices are fixture values.
import { prisma } from "@/lib/prisma";
import type { ImportSkipStage } from "@prisma/client";
import { betTypeLabel } from "@/lib/bet-line";
import { dedupCategory } from "@/lib/duplicate-pick-detection";
import { pickCategory } from "@/server/data/stats";
import { createPicksWithEntitlementCheck, type PickInsertData } from "@/server/data/subscriptions";
import { resolveImportRefs } from "@/server/data/import-refs";
import { EXISTING_PICK_SELECT, findDbDuplicate, type DbDupCandidate, type ExistingPickRow } from "@/server/data/duplicate-db-match";
import { insertPicksDeduped, rowBetIdentity, sportKeyForName, type DedupInsertOptions, type DedupPickRow } from "@/server/data/pick-dedup";
import { createPick, DuplicatePickError } from "@/server/data/picks";
import { mergeCappers } from "@/server/data/cappers";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const TAG = `dedup-${Date.now()}`;
const DRIFT = 6 * 3600_000;

// ---- LEGACY: the previous matcher, copied verbatim from duplicate-db-match.ts ----
function legacyDbDuplicateLabel(rows: ExistingPickRow[], candidate: DbDupCandidate & { dedupKey: string }, driftMs: number): string | null {
  const dbDup = rows.find((p) => {
    if (p.capperId !== candidate.capperId || p.sportId !== candidate.sportId) return false;
    if (p.homeTeam !== candidate.homeTeam || p.awayTeam !== candidate.awayTeam) return false;
    if (Math.abs(p.gameTime.getTime() - candidate.gameTimeMs) > driftMs) return false;
    if (p.period !== candidate.period) return false;
    const pCategory = pickCategory({ ...p, sportName: candidate.sportName });
    if (!pCategory) return false;
    const knownPlayerProp = p.propMarket && p.playerName ? { propMarket: p.propMarket, playerName: p.playerName } : null;
    return dedupCategory(pCategory, p.betType, p.betDetail, p.pickedSide, knownPlayerProp) === candidate.dedupKey;
  });
  return dbDup ? dbDup.betDetail || betTypeLabel(dbDup.betType) : null;
}

// ---- LEGACY: what bulkImportPicksAction did with the rows it was sent ----
async function legacyImport(userId: string, rows: DedupPickRow[]) {
  const pending = rows.map(({ overrideDuplicate: _o, raw: _r, capperId: _c, sportId: _s, ...rest }) => rest);
  const built = await resolveImportRefs(prisma, userId, pending);
  return createPicksWithEntitlementCheck(userId, built as PickInsertData[]);
}

type RowOver = Partial<DedupPickRow> & { capperName: string; betDetail: string };
function row(over: RowOver): DedupPickRow {
  return {
    sportName: "NCAAF",
    homeTeam: "Air Force Falcons",
    awayTeam: "Wyoming Cowboys",
    betType: "SPREAD",
    odds: -110,
    oddsSource: "STATED",
    line: null,
    period: "FULL_GAME",
    units: 1,
    gameTime: new Date("2026-10-10T01:00:00.000Z"),
    pickedSide: null,
    mlFavoredSide: null,
    ...over,
  } as DedupPickRow;
}

// The candidate the old preview would have built for `r`, and the logged rows
// it would have read - to ask the two matchers the same question.
async function matchers(userId: string, r: DedupPickRow) {
  const capper = await prisma.capper.findFirstOrThrow({ where: { userId, name: r.capperName } });
  const sport = await prisma.sport.findFirstOrThrow({ where: { name: r.sportName } });
  const identity = rowBetIdentity(r);
  const base = {
    capperId: capper.id,
    sportId: sport.id,
    sportName: r.sportName,
    homeTeam: r.homeTeam,
    awayTeam: r.awayTeam,
    gameTimeMs: r.gameTime.getTime(),
    period: identity.period,
  };
  // The old preview's category: pickCategory -> dedupCategory, no picked-side rule.
  const category = pickCategory({
    betType: r.betType,
    period: r.period ?? "FULL_GAME",
    betDetail: r.betDetail ?? null,
    odds: r.odds,
    line: r.line ?? null,
    sportName: r.sportName,
    pickedSide: r.pickedSide ?? null,
    mlFavoredSide: r.mlFavoredSide ?? null,
  });
  const rows = await prisma.pick.findMany({ where: { userId }, select: EXISTING_PICK_SELECT, orderBy: { id: "asc" } });
  const legacy = category
    ? legacyDbDuplicateLabel(rows, { ...base, dedupKey: dedupCategory(category, r.betType, r.betDetail ?? null, r.pickedSide ?? null) }, DRIFT)
    : null;
  const next = findDbDuplicate(
    rows,
    { ...base, dedupKey: identity.category, sportKey: sportKeyForName(r.sportName), betType: r.betType, pickedSide: identity.pickedSide },
    DRIFT
  );
  return { legacy, next: next ? next.betDetail : null };
}

async function main() {
  const userIds: string[] = [];
  const createdSports: string[] = [];
  const mkUser = async (suffix: string) => {
    const u = await prisma.user.create({ data: { supabaseId: `${TAG}-${suffix}`, email: `${TAG}-${suffix}@example.test` } });
    userIds.push(u.id);
    await prisma.subscription.create({ data: { userId: u.id, plan: "BASIC", status: "active" } });
    return u.id;
  };
  for (const name of ["NCAAF", "WNBA", "MLB", "NBA", "NHL"]) {
    if (!(await prisma.sport.findFirst({ where: { name } }))) {
      createdSports.push((await prisma.sport.create({ data: { name } })).id);
    }
  }
  const count = (userId: string) => prisma.pick.count({ where: { userId } });
  const logged = (userId: string, stage: ImportSkipStage) => prisma.importSkippedLine.findMany({ where: { userId, stage } });

  try {
    // ---- 1. Bullies PICKS: "Wyoming +10.5" imported twice ----
    {
      const wyoming = () => row({ capperName: "Bullies PICKS", betDetail: "Wyoming +10.5", line: 10.5, pickedSide: "AWAY" });
      const L = await mkUser("wyo-legacy");
      await legacyImport(L, [wyoming()]);
      await legacyImport(L, [wyoming()]);
      check("LEGACY reproduces: Wyoming +10.5 stored twice", (await count(L)) === 2, String(await count(L)));

      const N = await mkUser("wyo-new");
      const first = await insertPicksDeduped(N, [wyoming()]);
      const second = await insertPicksDeduped(N, [wyoming()]);
      check("NEW: first Wyoming +10.5 inserted", first.allowed && first.created.length === 1);
      check("NEW: second Wyoming +10.5 refused", second.allowed && second.created.length === 0 && second.skippedDuplicates.length === 1);
      check("NEW: Wyoming +10.5 stored once", (await count(N)) === 1, String(await count(N)));
      const stored = await prisma.pick.findFirstOrThrow({ where: { userId: N } });
      check(
        "NEW: the refusal names the logged pick",
        second.allowed && second.skippedDuplicates[0].existingPickId === stored.id && second.skippedDuplicates[0].existingLabel === "Wyoming +10.5"
      );
      const skips = await logged(N, "DUPLICATE_SKIPPED");
      check("NEW: the refusal is logged as DUPLICATE_SKIPPED", skips.length === 1 && (skips[0].reason ?? "").includes(stored.id), JSON.stringify(skips));
    }

    // ---- 2. PARLAY SAFARI: "Liberty 1H -7" then "Liberty 1st Half -7" ----
    {
      const liberty = (betDetail: string) =>
        row({
          capperName: "PARLAY SAFARI",
          sportName: "WNBA",
          homeTeam: "New York Liberty",
          awayTeam: "Atlanta Dream",
          betDetail,
          line: -7,
          period: "FIRST_HALF",
          pickedSide: "HOME",
          gameTime: new Date("2026-10-07T23:30:00.000Z"),
        });
      const L = await mkUser("lib-legacy");
      await legacyImport(L, [liberty("Liberty 1st Half -7")]);
      await legacyImport(L, [liberty("Liberty 1H -7")]);
      check("LEGACY reproduces: both Liberty first-half spreads stored", (await count(L)) === 2);

      const N = await mkUser("lib-new");
      await insertPicksDeduped(N, [liberty("Liberty 1st Half -7")]);
      const second = await insertPicksDeduped(N, [liberty("Liberty 1H -7")]);
      check('NEW: "Liberty 1H -7" refused as the logged "Liberty 1st Half -7"', second.allowed && second.skippedDuplicates[0]?.existingLabel === "Liberty 1st Half -7");
      check("NEW: one Liberty first-half spread stored", (await count(N)) === 1);
      // Not the same bet: the full-game spread, and the other team's first half.
      const others = await insertPicksDeduped(N, [
        { ...liberty("Liberty -12.5"), period: "FULL_GAME", line: -12.5 },
        { ...liberty("Over 80.5 1H"), betType: "TOTAL", line: 80.5, pickedSide: null },
      ]);
      check("NEW: a full-game spread and a first-half total on the same game still import", others.allowed && others.created.length === 2);
    }

    // ---- 3. The whole Liberty @ Dream paste imported twice ----
    {
      const paste = (variant: 0 | 1): DedupPickRow[] =>
        [
          { capperName: variant ? "ben burns" : "Ben Burns", betDetail: "Liberty -6.5", betType: "SPREAD" as const, line: -6.5, pickedSide: "AWAY" as const },
          { capperName: "KIMSPICKS", betDetail: "Liberty ML", betType: "MONEYLINE" as const, odds: -260, pickedSide: "AWAY" as const, mlFavoredSide: "AWAY" as const },
          { capperName: variant ? "Rhino" : "RHINO", betDetail: "Over 164.5", betType: "TOTAL" as const, line: 164.5 },
          { capperName: "Vinny", betDetail: "Dream +6.5", betType: "SPREAD" as const, line: 6.5, pickedSide: "HOME" as const },
        ].map((o) =>
          row({ sportName: "WNBA", homeTeam: "Atlanta Dream", awayTeam: "New York Liberty", gameTime: new Date("2026-10-07T23:30:00.000Z"), ...o })
        );
      const L = await mkUser("paste-legacy");
      await legacyImport(L, paste(0));
      await legacyImport(L, paste(1));
      check("LEGACY reproduces: the paste stored twice (8 rows)", (await count(L)) === 8, String(await count(L)));

      const N = await mkUser("paste-new");
      const first = await insertPicksDeduped(N, paste(0));
      const second = await insertPicksDeduped(N, paste(1));
      check("NEW: first paste imports all 4", first.allowed && first.created.length === 4);
      check("NEW: second paste imports nothing, refuses all 4", second.allowed && second.created.length === 0 && second.skippedDuplicates.length === 4);
      check("NEW: 4 rows stored, not 8", (await count(N)) === 4, String(await count(N)));
      check("NEW: no second capper record for a re-cased name", (await prisma.capper.count({ where: { userId: N } })) === 4);

      // The same pick twice in ONE request (nothing logged yet for a new capper).
      const twice = await insertPicksDeduped(N, [
        row({ capperName: "Brand New Capper", betDetail: "Wyoming +10.5", line: 10.5 }),
        row({ capperName: "brand new capper", betDetail: "Wyoming +10", line: 10 }),
      ]);
      check(
        "NEW: a pick sent twice in one request is inserted once",
        twice.allowed && twice.created.length === 1 && twice.skippedDuplicates[0]?.earlierIndex === 0 && twice.skippedDuplicates[0]?.existingPickId === null
      );
    }

    // ---- 4. Score-feed spelling vs Odds API spelling ----
    {
      const spellings: { sport: string; home: [string, string]; away: [string, string] }[] = [
        { sport: "NCAAF", home: ["Hawai'i Rainbow Warriors", "Hawaii Rainbow Warriors"], away: ["App State Mountaineers", "Appalachian State Mountaineers"] },
        { sport: "NBA", home: ["LA Clippers", "Los Angeles Clippers"], away: ["Denver Nuggets", "Denver Nuggets"] },
        { sport: "NHL", home: ["Montréal Canadiens", "Montreal Canadiens"], away: ["St. Louis Blues", "St Louis Blues"] },
      ];
      const N = await mkUser("spelling-new");
      for (const s of spellings) {
        const pick = (which: 0 | 1) =>
          row({ capperName: "Feed Capper", sportName: s.sport, homeTeam: s.home[which], awayTeam: s.away[which], betDetail: "Over 51.5", betType: "TOTAL", line: 51.5 });
        const before = await count(N);
        await insertPicksDeduped(N, [pick(0)]);
        const m = await matchers(N, pick(1));
        check(`LEGACY reproduces (${s.sport}): the old matcher misses the Odds API spelling`, m.legacy === null, String(m.legacy));
        check(`NEW (${s.sport}): the matcher finds it across spellings`, m.next === "Over 51.5", String(m.next));
        const second = await insertPicksDeduped(N, [pick(1)]);
        check(`NEW (${s.sport}): the Odds-API-spelled copy is refused`, second.allowed && second.skippedDuplicates.length === 1 && (await count(N)) === before + 1);
      }
      // An alias must not join two different teams.
      const tech = await insertPicksDeduped(N, [
        row({ capperName: "Feed Capper", homeTeam: "Louisiana Tech Bulldogs", awayTeam: "App State Mountaineers", betDetail: "Over 51.5", betType: "TOTAL", line: 51.5 }),
      ]);
      check("NEW: a different team on the same night is not a duplicate", tech.allowed && tech.created.length === 1);
    }

    // ---- 5. Moneyline: favourite on the first import, underdog on the second ----
    {
      const cubs = (odds: number, favored: "HOME" | "AWAY") =>
        row({
          capperName: "ML Capper",
          sportName: "MLB",
          homeTeam: "Chicago Cubs",
          awayTeam: "Milwaukee Brewers",
          betType: "MONEYLINE",
          betDetail: "Cubs ML",
          odds,
          pickedSide: "HOME",
          mlFavoredSide: favored,
          gameTime: new Date("2026-10-08T18:20:00.000Z"),
        });
      const N = await mkUser("ml-new");
      await insertPicksDeduped(N, [cubs(-115, "HOME")]);
      const m = await matchers(N, cubs(+105, "AWAY"));
      check("LEGACY reproduces: FAV_ML vs DOG_ML hides the flipped moneyline", m.legacy === null, String(m.legacy));
      check("NEW: the matcher compares the picked team", m.next === "Cubs ML", String(m.next));
      const second = await insertPicksDeduped(N, [cubs(+105, "AWAY")]);
      check("NEW: the flipped Cubs ML is refused", second.allowed && second.skippedDuplicates.length === 1 && (await count(N)) === 1);
      const other = await insertPicksDeduped(N, [{ ...cubs(-105, "AWAY"), betDetail: "Brewers ML", pickedSide: "AWAY" }]);
      check("NEW: the other team's moneyline is a different bet", other.allowed && other.created.length === 1 && (await count(N)) === 2);

      const L = await mkUser("ml-legacy");
      await legacyImport(L, [cubs(-115, "HOME")]);
      await legacyImport(L, [cubs(+105, "AWAY")]);
      check("LEGACY reproduces: both Cubs ML rows stored", (await count(L)) === 2);
    }

    // ---- 6. Two imports of the same pick at the same moment ----
    {
      const pick = () => row({ capperName: "Race Capper", betDetail: "Wyoming +10.5", line: 10.5 });
      const L = await mkUser("race-legacy");
      await prisma.capper.create({ data: { userId: L, name: "Race Capper", source: "OTHER" } });
      await Promise.all([legacyImport(L, [pick()]), legacyImport(L, [pick()])]);
      check("LEGACY reproduces: two concurrent imports both insert", (await count(L)) === 2, String(await count(L)));

      const N = await mkUser("race-new");
      await prisma.capper.create({ data: { userId: N, name: "Race Capper", source: "OTHER" } });
      // Each transaction stalls AFTER its duplicate read: without the per-user
      // lock both would have read "nothing logged" long before either inserts.
      const slowRead: DedupInsertOptions = {
        readExistingPicks: async (tx, where) => {
          const rows = await tx.pick.findMany({ where, select: EXISTING_PICK_SELECT, orderBy: { id: "asc" } });
          await new Promise((resolve) => setTimeout(resolve, 400));
          return rows;
        },
      };
      const results = await Promise.all([insertPicksDeduped(N, [pick()], slowRead), insertPicksDeduped(N, [pick()], slowRead)]);
      const createdTotal = results.reduce((n, r) => n + (r.allowed ? r.created.length : 0), 0);
      const refusedTotal = results.reduce((n, r) => n + r.skippedDuplicates.length, 0);
      check("NEW: of two concurrent imports exactly one inserts", createdTotal === 1 && refusedTotal === 1, `created ${createdTotal}, refused ${refusedTotal}`);
      check("NEW: one row stored after the race", (await count(N)) === 1, String(await count(N)));

      // Five at once, for a capper that does not exist yet.
      const five = await Promise.all(
        [0, 1, 2, 3, 4].map(() => insertPicksDeduped(N, [row({ capperName: "Race Rookie", betDetail: "Air Force -10.5", line: -10.5 })]))
      );
      check("NEW: five concurrent imports of one pick insert it once", five.reduce((n, r) => n + (r.allowed ? r.created.length : 0), 0) === 1 && (await count(N)) === 2);
    }

    // ---- 7. A failing check blocks the import ----
    {
      const N = await mkUser("fail-new");
      await insertPicksDeduped(N, [row({ capperName: "Fail Capper", betDetail: "Wyoming +10.5", line: 10.5 })]);
      let threw = false;
      try {
        await insertPicksDeduped(
          N,
          [
            row({ capperName: "Fail Capper", betDetail: "Over 44.5", betType: "TOTAL", line: 44.5 }),
            row({ capperName: "Never Created", betDetail: "Under 44.5", betType: "TOTAL", line: 44.5 }),
          ],
          {
            readExistingPicks: async () => {
              throw new Error("simulated duplicate-check failure");
            },
          }
        );
      } catch {
        threw = true;
      }
      check("NEW: a failed duplicate check fails the import", threw);
      check("NEW: nothing was inserted behind the failed check", (await count(N)) === 1, String(await count(N)));
      check("NEW: no capper was created by the failed import", (await prisma.capper.count({ where: { userId: N, name: "Never Created" } })) === 0);
    }

    // ---- 8. An explicit override inserts, and is logged ----
    {
      const pick = (over: Partial<DedupPickRow> = {}) =>
        row({ capperName: "Override Capper", betDetail: "Wyoming +10.5", line: 10.5, raw: "Wyoming +10.5 (2u)", ...over });
      const N = await mkUser("override-new");
      await insertPicksDeduped(N, [pick()]);
      const original = await prisma.pick.findFirstOrThrow({ where: { userId: N } });
      const res = await insertPicksDeduped(N, [pick({ overrideDuplicate: true }), pick({ betDetail: "Wyoming +10", line: 10 })]);
      check("NEW: the overridden duplicate is inserted", res.allowed && res.created.length === 1 && res.overridden.length === 1 && res.insertedIndexes[0] === 0);
      check("NEW: the duplicate with no override in the same request is refused", res.allowed && res.skippedDuplicates.length === 1 && res.skippedDuplicates[0].index === 1);
      check("NEW: two rows stored after one override", (await count(N)) === 2, String(await count(N)));
      const overrides = await logged(N, "DUPLICATE_OVERRIDDEN");
      check("NEW: the override is logged as DUPLICATE_OVERRIDDEN", overrides.length === 1, JSON.stringify(overrides));
      check(
        "NEW: the log row carries the pasted line, the capper and the pick it duplicates",
        overrides[0]?.rawText === "Wyoming +10.5 (2u)" && overrides[0]?.capperName === "Override Capper" && (overrides[0]?.reason ?? "").includes(original.id)
      );
      check("NEW: an import with no duplicate logs no override", (await logged(N, "DUPLICATE_OVERRIDDEN")).length === 1);
      const flagOnly = await insertPicksDeduped(N, [row({ capperName: "Override Capper", betDetail: "Under 41.5", betType: "TOTAL", line: 41.5, overrideDuplicate: true })]);
      check("NEW: an override flag on a non-duplicate inserts and logs nothing", flagOnly.allowed && flagOnly.overridden.length === 0 && (await logged(N, "DUPLICATE_OVERRIDDEN")).length === 1);
    }

    // ---- 9. Not duplicates: must still import ----
    {
      const N = await mkUser("distinct-new");
      const base = { capperName: "Distinct Capper" };
      const res = await insertPicksDeduped(N, [
        row({ ...base, betDetail: "Wyoming +10.5", line: 10.5 }),
        row({ ...base, betDetail: "Air Force -10.5", line: -10.5 }), // other side
        row({ ...base, betDetail: "Wyoming +6 1H", line: 6, period: "FIRST_HALF" }), // other segment
        row({ ...base, betDetail: "Over 44.5", betType: "TOTAL", line: 44.5 }),
        row({ ...base, betDetail: "Under 44.5", betType: "TOTAL", line: 44.5 }),
        row({ ...base, betDetail: "Wyoming +10.5", line: 10.5, gameTime: new Date("2026-10-17T01:00:00.000Z") }), // next week
        row({ capperName: "Another Capper", betDetail: "Wyoming +10.5", line: 10.5 }), // other capper
      ]);
      check("NEW: seven different bets all import", res.allowed && res.created.length === 7 && res.skippedDuplicates.length === 0, JSON.stringify(res));
    }

    // ---- 10. Manual single-pick entry ----
    {
      const N = await mkUser("manual-new");
      const capper = await prisma.capper.create({ data: { userId: N, name: "Manual Capper", source: "OTHER" } });
      const sport = await prisma.sport.findFirstOrThrow({ where: { name: "NCAAF" } });
      const data = {
        capperId: capper.id,
        sportId: sport.id,
        homeTeam: "Air Force Falcons",
        awayTeam: "Wyoming Cowboys",
        betType: "SPREAD" as const,
        betDetail: "Wyoming +10.5",
        odds: -110,
        line: 10.5,
        units: 1,
        gameTime: new Date("2026-10-10T01:00:00.000Z"),
      };
      await createPick(N, data);
      let refused: unknown = null;
      try {
        await createPick(N, data);
      } catch (err) {
        refused = err;
      }
      check("NEW: the manual form's second copy is refused", refused instanceof DuplicatePickError && (await count(N)) === 1, String(refused));
      await createPick(N, data, { allowDuplicate: true });
      check("NEW: the manual form's explicit Add anyway inserts", (await count(N)) === 2);
      check("NEW: and is logged as DUPLICATE_OVERRIDDEN", (await logged(N, "DUPLICATE_OVERRIDDEN")).length === 1);
      // An import of a pick the manual form logged is caught too.
      const viaImport = await insertPicksDeduped(N, [row({ capperName: "manual capper", betDetail: "Wyoming +10", line: 10 })]);
      check("NEW: an import of a manually-logged pick is refused", viaImport.allowed && viaImport.skippedDuplicates.length === 1);
    }

    // ---- 11. Capper merge reports the duplicates it creates, deletes nothing ----
    {
      const N = await mkUser("merge-new");
      await insertPicksDeduped(N, [
        row({ capperName: "Sharp Sheet", betDetail: "Wyoming +10.5", line: 10.5 }),
        row({ capperName: "Sharp Sheet", betDetail: "Over 44.5", betType: "TOTAL", line: 44.5 }),
      ]);
      // A second record the name rules would never create today - made directly,
      // the way the production pair must predate them.
      const twin = await prisma.capper.create({ data: { userId: N, name: "SHARP SHEET (old)", source: "OTHER" } });
      await insertPicksDeduped(N, [
        row({ capperName: "SHARP SHEET (old)", betDetail: "Wyoming +10", line: 10 }),
        row({ capperName: "SHARP SHEET (old)", betDetail: "Under 44.5", betType: "TOTAL", line: 44.5 }),
      ]);
      const primary = await prisma.capper.findFirstOrThrow({ where: { userId: N, name: "Sharp Sheet" } });
      const before = await prisma.pick.findMany({ where: { userId: N }, orderBy: { id: "asc" } });
      const res = await mergeCappers(N, primary.id, twin.id);
      const after = await prisma.pick.findMany({ where: { userId: N }, orderBy: { id: "asc" } });
      check("merge: both of the merged capper's picks moved", res.mergedPickCount === 2);
      check("merge: no pick deleted", after.length === 4 && after.every((p) => p.capperId === primary.id), String(after.length));
      check(
        "merge: no pick changed apart from its capper",
        JSON.stringify(after.map(({ capperId: _c, updatedAt: _u, ...p }) => p)) === JSON.stringify(before.map(({ capperId: _c, updatedAt: _u, ...p }) => p))
      );
      const kept = before.find((p) => p.betDetail === "Wyoming +10.5");
      const moved = before.find((p) => p.betDetail === "Wyoming +10");
      check(
        "merge: the one duplicate pair is reported with both pick ids",
        res.duplicatePicks.length === 1 && res.duplicatePicks[0].keptPickId === kept?.id && res.duplicatePicks[0].movedPickId === moved?.id,
        JSON.stringify(res.duplicatePicks)
      );
    }
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    if (createdSports.length) await prisma.sport.deleteMany({ where: { id: { in: createdSports } } });
  }
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    if (failures > 0) {
      console.error(`\n${failures} assertion(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll pick-dedup assertions passed.");
  });
