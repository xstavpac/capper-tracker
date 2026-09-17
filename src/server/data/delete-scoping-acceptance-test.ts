// Proof that deletePick / deleteParlayBet / deleteCustomMetric scope their
// delete by id + userId ONLY - never a name or any other text match. This is
// the standing project rule after a text-`where` deleteMany once ran against
// production (see the delete-queries-must-filter-by-id-only note). Also checks
// deletePick/deleteParlayBet's not-found path throws rather than silently
// succeeding (deleteCustomMetric deliberately does not - see below).
//
// Pure: the prisma singleton's deleteMany is swapped for a spy before the
// call, so no database is touched. Run with:
//   npx tsx src/server/data/delete-scoping-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { prisma } from "@/lib/prisma";
import { deletePick } from "@/server/data/picks";
import { deleteParlayBet } from "@/server/data/parlays";
import { deleteCustomMetric } from "@/server/data/custom-metrics";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

type SpyState = { calls: unknown[]; result: { count: number } };

function spyOn(model: { deleteMany: (args: unknown) => Promise<{ count: number }> }): SpyState {
  const state: SpyState = { calls: [], result: { count: 1 } };
  model.deleteMany = async (args: unknown) => {
    state.calls.push(args);
    return state.result;
  };
  return state;
}

async function main() {
  // ---- deletePick ----
  {
    const spy = spyOn(prisma.pick as unknown as { deleteMany: (a: unknown) => Promise<{ count: number }> });

    await deletePick("user-123", "pick-abc");
    expect("deletePick issues exactly one deleteMany", spy.calls.length, 1);
    expect(
      "deletePick where clause is id + userId only",
      spy.calls[0],
      { where: { id: "pick-abc", userId: "user-123" } }
    );
    const keys = Object.keys((spy.calls[0] as { where: Record<string, unknown> }).where).sort();
    expect("deletePick where has no other keys (no name/text match)", keys, ["id", "userId"]);

    spy.result = { count: 0 };
    let threw: string | null = null;
    try {
      await deletePick("user-123", "missing");
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    expect("deletePick throws when nothing matched (count 0)", threw, "Pick not found.");
  }

  // ---- deleteParlayBet ----
  {
    const spy = spyOn(prisma.parlayBet as unknown as { deleteMany: (a: unknown) => Promise<{ count: number }> });

    await deleteParlayBet("user-9", "parlay-xyz");
    expect("deleteParlayBet issues exactly one deleteMany", spy.calls.length, 1);
    expect(
      "deleteParlayBet where clause is id + userId only",
      spy.calls[0],
      { where: { id: "parlay-xyz", userId: "user-9" } }
    );
    const keys = Object.keys((spy.calls[0] as { where: Record<string, unknown> }).where).sort();
    expect("deleteParlayBet where has no other keys", keys, ["id", "userId"]);

    spy.result = { count: 0 };
    let threw: string | null = null;
    try {
      await deleteParlayBet("user-9", "missing");
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    expect("deleteParlayBet throws when nothing matched (count 0)", threw, "Parlay not found.");
  }

  // ---- deleteCustomMetric ----
  {
    const spy = spyOn(prisma.customMetric as unknown as { deleteMany: (a: unknown) => Promise<{ count: number }> });

    await deleteCustomMetric("user-42", "metric-abc");
    expect("deleteCustomMetric issues exactly one deleteMany", spy.calls.length, 1);
    expect(
      "deleteCustomMetric where clause is id + userId only",
      spy.calls[0],
      { where: { id: "metric-abc", userId: "user-42" } }
    );
    const keys = Object.keys((spy.calls[0] as { where: Record<string, unknown> }).where).sort();
    expect("deleteCustomMetric where has no other keys (no name/text match)", keys, ["id", "userId"]);

    // Unlike deletePick/deleteParlayBet, a no-match delete here is a silent
    // no-op by design - deleting a metric you don't own (or a stale id after
    // a double-click) shouldn't surface an error to the user, and the caller
    // (deleteCustomMetricAction) revalidates + refreshes regardless.
    spy.result = { count: 0 };
    let threw = false;
    try {
      await deleteCustomMetric("user-42", "missing");
    } catch {
      threw = true;
    }
    expect("deleteCustomMetric does NOT throw when nothing matched", threw, false);
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  if (failures > 0) process.exit(1);
}

main();
