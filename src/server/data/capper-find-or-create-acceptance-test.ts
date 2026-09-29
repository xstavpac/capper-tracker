// findOrCreateCapper + the unique index cappers_user_lower_name_key + rename.
//
// Real-database test (needs the migration applied), run with DATABASE_URL set:
//   npx tsx src/server/data/capper-find-or-create-acceptance-test.ts
// Exits non-zero on any failed assertion.
//
//  1. "Shark" / " shark " / "SHARK" -> one capper; name stored as typed (trimmed).
//  2. Strict normalizeName match ("Sharp Sam" / "SharpSam" / "Sharp-Sam") -> one capper.
//  3. Emoji-only / punctuation-only names: normalizeName is "" so it is skipped;
//     two DIFFERENT such names stay two cappers, the same one resolves to itself.
//  4. Same name for two different users is allowed.
//  5. N parallel calls with one name -> exactly one row, every call returns its id.
//  6. Inside an explicit $transaction a conflict does not abort it.
//  7. The real bulkImportPicksAction with a duplicate name mid-batch succeeds.
//  8. createCapper / renameCapper: friendly errors; self-rename by case works.
//  9. The raw INSERT covers every Capper column that has no database default
//     (checked against Prisma's DMMF).
//  10. The unique index really exists and rejects a direct duplicate insert.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { findOrCreateCapper, CAPPER_INSERT_COLUMNS } from "@/server/data/capper-find-or-create";
import { createCapper, renameCapper } from "@/server/data/cappers";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}
async function rejects(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const TAG = `fc-${Date.now()}`;

async function main() {
  const userIds: string[] = [];
  const mkUser = async (suffix: string) => {
    const u = await prisma.user.create({ data: { supabaseId: `${TAG}-${suffix}`, email: `${TAG}-${suffix}@example.test` } });
    userIds.push(u.id);
    return u;
  };
  const count = (userId: string) => prisma.capper.count({ where: { userId } });
  const savedEnv = process.env as Record<string, string | undefined>;
  const saved = { NODE_ENV: savedEnv.NODE_ENV, DEV_AUTH_BYPASS: savedEnv.DEV_AUTH_BYPASS };
  let createdMlb: string | null = null;

  try {
    const u1 = await mkUser("u1");
    const u2 = await mkUser("u2");

    // 1
    const a = await findOrCreateCapper(u1.id, "Shark");
    const b = await findOrCreateCapper(u1.id, " shark ");
    const c = await findOrCreateCapper(u1.id, "SHARK");
    check("case/whitespace variants resolve to one capper", a.created && !b.created && !c.created && a.capper.id === b.capper.id && b.capper.id === c.capper.id);
    check("stored name is as first typed (trimmed)", a.capper.name === "Shark");
    check("only one row", (await count(u1.id)) === 1);
    const typed = await findOrCreateCapper(u1.id, "  Mixed Case  ");
    check("name stored trimmed, case kept", typed.capper.name === "Mixed Case");

    // 2
    const s1 = await findOrCreateCapper(u1.id, "Sharp Sam");
    const s2 = await findOrCreateCapper(u1.id, "SharpSam");
    const s3 = await findOrCreateCapper(u1.id, "Sharp-Sam");
    check("strict normalizeName match preserved", s1.capper.id === s2.capper.id && s2.capper.id === s3.capper.id);

    // 3
    const e1 = await findOrCreateCapper(u1.id, "🔥🔥");
    const e2 = await findOrCreateCapper(u1.id, "💰");
    const e1b = await findOrCreateCapper(u1.id, " 🔥🔥 ");
    const p1 = await findOrCreateCapper(u1.id, "!!!");
    const p2 = await findOrCreateCapper(u1.id, "???");
    check("two different emoji-only names are two cappers", e1.capper.id !== e2.capper.id && e1.created && e2.created);
    check("the same emoji-only name resolves to itself (index rule)", e1b.capper.id === e1.capper.id && !e1b.created);
    check("two different punctuation-only names are two cappers", p1.capper.id !== p2.capper.id);

    // 4
    const other = await findOrCreateCapper(u2.id, "Shark");
    check("same name for a different user is allowed", other.created && other.capper.id !== a.capper.id && other.capper.userId === u2.id);

    // 5
    const N = 20;
    const results = await Promise.all(Array.from({ length: N }, (_, i) => findOrCreateCapper(u2.id, i % 2 ? " RACE Name" : "race name ")));
    const ids = new Set(results.map((r) => r.capper.id));
    const rows = await prisma.capper.findMany({ where: { userId: u2.id, name: { in: ["race name", "RACE Name"], mode: "insensitive" } } });
    check(`${N} parallel calls -> exactly one row`, rows.length === 1, String(rows.length));
    check("...and every call returns that id", ids.size === 1 && ids.has(rows[0].id));
    check("...exactly one call reports created", results.filter((r) => r.created).length === 1);

    // 6
    const txResult = await prisma.$transaction(async (tx) => {
      const first = await findOrCreateCapper(u2.id, "Tx One", undefined, tx);
      const dup = await findOrCreateCapper(u2.id, "tx one", undefined, tx);
      // Force the index-rule path (normalizeName-empty names skip the pre-check).
      await findOrCreateCapper(u2.id, "🧪", undefined, tx);
      const dupIndexOnly = await findOrCreateCapper(u2.id, "🧪", undefined, tx);
      const after = await tx.capper.count({ where: { userId: u2.id } });
      return { first, dup, dupIndexOnly, after };
    });
    check("conflict inside $transaction returns the existing capper", txResult.first.capper.id === txResult.dup.capper.id && !txResult.dup.created);
    check("index-rule conflict inside $transaction does not abort it", !txResult.dupIndexOnly.created && txResult.after >= 3);
    check("transaction committed", (await prisma.capper.count({ where: { userId: u2.id, name: "Tx One" } })) === 1);

    // 7 - real bulk import path, duplicate mid-batch
    savedEnv.NODE_ENV = "development";
    savedEnv.DEV_AUTH_BYPASS = "true";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const react = require("react") as { cache?: unknown };
    react.cache ??= <T,>(fn: T) => fn;
    if (!(await prisma.sport.findFirst({ where: { name: { equals: "MLB", mode: "insensitive" } } }))) {
      createdMlb = (await prisma.sport.create({ data: { name: "MLB" } })).id;
    }
    const { bulkImportPicksAction } = await import("@/server/actions/bulk-picks");
    const mk = (capperName: string, i: number) => ({
      capperName,
      sportName: "MLB",
      description: `Nowhere Nobody -1.5 #${i}`,
      betType: "SPREAD" as const,
      odds: -110,
      hasExplicitOdds: true,
      teamNicknames: [] as string[],
      units: 1,
      period: "FULL_GAME" as const,
      gameNumber: null,
    });
    const names = [`${TAG} Bulk`, `${TAG} Other`, `${TAG.toUpperCase()} bulk `, `${TAG} Bulk`, `${TAG} O-ther`];
    // Outside a Next request the action's trailing revalidateTag throws
    // "static generation store missing" - AFTER every capper was resolved and all
    // writes finished. That one harness artifact is tolerated; anything else is a failure.
    let out: { success?: boolean } = {};
    let actionError: string | null = null;
    try {
      out = (await bulkImportPicksAction(names.map(mk) as never)) as { success?: boolean };
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
      if (!/static generation store missing/.test(actionError)) throw e;
    }
    const dev = await prisma.user.findFirst({ where: { supabaseId: "dev-local-bypass" } });
    if (dev && dev.createdAt.getTime() >= Date.now() - 600000) userIds.push(dev.id);
    const devCappers = dev ? await prisma.capper.findMany({ where: { userId: dev.id, name: { contains: TAG, mode: "insensitive" } } }) : [];
    check("bulk import with duplicate names mid-batch does not throw/abort", actionError !== null || out.success === true, JSON.stringify(out).slice(0, 200));
    check("...and created exactly the two distinct cappers", devCappers.length === 2, devCappers.map((x) => x.name).join("|"));
    if (dev && devCappers.length) await prisma.capper.deleteMany({ where: { id: { in: devCappers.map((x) => x.id) } } });

    // 8
    const u3 = await mkUser("u3");
    const cap = await findOrCreateCapper(u3.id, "Alpha");
    const bravo = await findOrCreateCapper(u3.id, "Bravo");
    const createDup = await rejects(() => createCapper(u3.id, { name: " alpha", source: "OTHER" }));
    check("createCapper duplicate -> friendly error", createDup === 'You already have a capper named "alpha".', String(createDup));
    const collide = await rejects(() => renameCapper(u3.id, bravo.capper.id, "ALPHA "));
    check("rename into a collision -> friendly error", collide === 'You already have a capper named "ALPHA".', String(collide));
    const collideStrict = await rejects(() => renameCapper(u3.id, bravo.capper.id, "Al-pha"));
    check("rename into a strict-normalize collision -> friendly error", !!collideStrict && collideStrict.startsWith("You already have"), String(collideStrict));
    check("...and the capper kept its name", (await prisma.capper.findUniqueOrThrow({ where: { id: bravo.capper.id } })).name === "Bravo");
    const selfCase = await rejects(() => renameCapper(u3.id, cap.capper.id, "ALPHA"));
    check("self-rename with a case change works", selfCase === null && (await prisma.capper.findUniqueOrThrow({ where: { id: cap.capper.id } })).name === "ALPHA", String(selfCase));
    const selfSpace = await rejects(() => renameCapper(u3.id, cap.capper.id, "  alpha  "));
    check("self-rename with spacing/case works", selfSpace === null && (await prisma.capper.findUniqueOrThrow({ where: { id: cap.capper.id } })).name === "alpha", String(selfSpace));
    const otherUserOk = await rejects(() => renameCapper(u2.id, other.capper.id, "Alpha"));
    check("renaming to another user's capper's name is fine", otherUserOk === null, String(otherUserOk));

    // 9 - DMMF vs the raw insert column list
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === "Capper")!;
    const scalars = model.fields.filter((f) => f.kind === "scalar" || f.kind === "enum");
    const listed = new Set<string>(CAPPER_INSERT_COLUMNS);
    const prismaSideDefault = (f: (typeof scalars)[number]) =>
      f.isUpdatedAt || (f.hasDefaultValue && typeof f.default === "object" && f.default !== null && "name" in f.default && ["cuid", "uuid", "nanoid", "ulid"].includes(String((f.default as { name: string }).name)));
    const dbDefault = (f: (typeof scalars)[number]) => f.hasDefaultValue && !prismaSideDefault(f);
    const missing = scalars.filter((f) => f.isRequired && !dbDefault(f) && !listed.has(f.name)).map((f) => f.name);
    check("raw insert sets every required Capper column that has no DB default", missing.length === 0, "missing: " + missing.join(", "));
    const unknown = CAPPER_INSERT_COLUMNS.filter((n) => !scalars.some((f) => f.name === n));
    check("raw insert only names real Capper columns", unknown.length === 0, unknown.join(", "));
    const dbCols = await prisma.$queryRaw<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
      SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'cappers'`;
    const dbMissing = dbCols.filter((r) => r.is_nullable === "NO" && r.column_default === null && !listed.has(r.column_name)).map((r) => r.column_name);
    check("...and against the live table (NOT NULL, no default)", dbMissing.length === 0, "missing: " + dbMissing.join(", "));

    // 10
    const idx = await prisma.$queryRaw<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE indexname = 'cappers_user_lower_name_key'`;
    check("unique index exists on (userId, lower(btrim(name)))", idx.length === 1 && /UNIQUE/.test(idx[0].indexdef) && /lower\(btrim\(/.test(idx[0].indexdef), idx[0]?.indexdef);
    const raw = await rejects(() => prisma.capper.create({ data: { userId: u3.id, name: " BRAVO", source: "OTHER" } }));
    check("a direct duplicate insert is rejected by the DB", !!raw);
  } finally {
    savedEnv.NODE_ENV = saved.NODE_ENV;
    savedEnv.DEV_AUTH_BYPASS = saved.DEV_AUTH_BYPASS;
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    if (createdMlb) await prisma.sport.deleteMany({ where: { id: createdMlb } });
  }
}

main()
  .catch((err) => {
    console.error("FAIL: unexpected error", err);
    failures++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(failures ? 1 : 0);
  });
