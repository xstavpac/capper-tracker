// Stamp Pick.uniqueKey on every pick (all users, all time) with the same TS uniquePickKey the app uses.
//   npx tsx scripts/backfill-unique-key.ts            # DRY RUN (default): reads, reports, writes nothing
//   npx tsx scripts/backfill-unique-key.ts --apply    # writes, one `UPDATE ... WHERE id = $id` per changed row
//   npx tsx scripts/backfill-unique-key.ts --verify   # READ-ONLY: NULL-key count + stratified drift sample; exit 1 on any
//   add --text-only to a dry run / --apply: only picks whose stored key contains "||TEXT:" (a change to the text
//   fallback alone). --verify always checks every bet type, with or without it.
// Keyset batches by id; idempotent (a second --apply writes 0). Engine: src/server/data/pick-unique-key.ts.
// Prints the target host (never credentials) first so the database can be confirmed.
import { prisma } from "@/lib/prisma";
import { backfillUniqueKeys, verifyUniqueKeys } from "@/server/data/pick-unique-key";

const apply = process.argv.includes("--apply");
const verify = process.argv.includes("--verify");
const textOnly = process.argv.includes("--text-only");
const sizeArg = process.argv.find((a) => a.startsWith("--batch="));
const batchSize = sizeArg ? Number(sizeArg.slice("--batch=".length)) : 1000;
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new Error("--batch must be 1..5000");
if (apply && verify) throw new Error("--verify is read-only; it can't be combined with --apply");

function targetHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").host || "(unset)";
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function main() {
  console.log(`[unique-key] target: ${targetHost()}`);
  if (verify) {
    if (textOnly) console.log("[unique-key] note: --verify ignores --text-only and samples every bet type");
    const r = await verifyUniqueKeys();
    console.log(`[unique-key] picks with uniqueKey IS NULL: ${r.nullKeys}`);
    console.log(`[unique-key] sampled ${r.sampled}: ${JSON.stringify(r.sampledByType)}`);
    console.log(`[unique-key] mismatches: ${r.mismatches.length}`);
    for (const m of r.mismatches.slice(0, 20)) console.log(`  ${m.id} ${m.betType}\n    stored:   ${m.stored}\n    computed: ${m.computed}`);
    if (r.nullKeys > 0 || r.mismatches.length > 0) process.exitCode = 1;
    return;
  }
  const r = await backfillUniqueKeys({ apply, batchSize, textOnly });
  if (r.read !== r.total) console.log(`[unique-key] note: read ${r.read} but counted ${r.total} at start (rows added/removed during the run)`);
}

main()
  .catch((err) => {
    console.error("[unique-key] FAILED:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
