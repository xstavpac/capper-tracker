// Proof for page-load grading's demand gate + persist throttle (page-grading.ts)
// that replaced the unconditional persist-then-grade-then-regrade loop in
// /picks and /live/[gameId].
//
// Covers: the gate (nothing due -> no persist, no grade, one query), the gate
// query's own shape (one findMany, gameTime <= now + MAX_GAME_TIME_DRIFT_MS),
// only-due-sports work, the throttle (one persist per window however many
// views, again after the window rolls), the cross-instance claim losing, a
// persist failure NOT skipping grading (and being retried on the next view),
// best-effort swallowing, single-sport scoping for /live, and - by source
// inspection - that both cron routes still call the raw persistFinalScores and
// that neither page calls persist/regrade directly any more.
//
// Pure: no database. deps are injected; the one prisma call under test
// (sport.findMany) is swapped for a spy. Run with:
//   npx tsx src/server/data/page-grading-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { MAX_GAME_TIME_DRIFT_MS } from "@/server/data/grading";
import {
  PAGE_PERSIST_THROTTLE_SECONDS,
  gradeUserPagePicks,
  sportNamesWithDuePendingPicks,
  throttledPersistFinalScores,
  type PageGradingDeps,
} from "@/server/data/page-grading";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  if (!pass) failures++;
}

const MLB = "baseball_mlb";
const NFL = "americanfootball_nfl";
const NBA = "basketball_nba";
const WINDOW = 45;

// One monotonic fake clock for the whole file: the process-local memo inside
// throttledPersistFinalScores is module state shared by every scenario, so time
// only ever moves forward (an hour between scenarios keeps them independent).
let clock = Date.UTC(2026, 8, 28, 12, 0, 0);
function nextScenario() {
  clock += 3600_000;
}

function makeDeps(opts: {
  due?: string[] | Error;
  persist?: (sportKey: string) => Promise<unknown>;
  grade?: (userId: string, sportName: string, sportKey: string) => Promise<unknown>;
  claim?: "lease" | boolean;
}) {
  const calls = { due: 0, persist: [] as string[], grade: [] as string[], claim: [] as string[] };
  const leases = new Set<string>();
  const deps: PageGradingDeps = {
    now: () => clock,
    dueSportNames: async () => {
      calls.due++;
      if (opts.due instanceof Error) throw opts.due;
      return new Set(opts.due ?? []);
    },
    claimWindow: async (sportKey, bucket) => {
      const key = `${sportKey}:${bucket}`;
      calls.claim.push(key);
      if (typeof opts.claim === "boolean") return opts.claim;
      if (leases.has(key)) return false; // stands in for the shared Data Cache entry
      leases.add(key);
      return true;
    },
    persist: async (sportKey) => {
      calls.persist.push(sportKey);
      return opts.persist ? opts.persist(sportKey) : 1;
    },
    grade: async (userId, sportName, sportKey) => {
      calls.grade.push(`${sportName}|${sportKey}`);
      return opts.grade ? opts.grade(userId, sportName, sportKey) : { graded: 0, notMatched: 0 };
    },
  };
  return { deps, calls };
}

async function main() {
  // ---- 0. Default window ----
  expect("default page persist window is 45s (env unset)", PAGE_PERSIST_THROTTLE_SECONDS, 45);

  // ---- 1. Gate: nothing due -> no work at all ----
  {
    nextScenario();
    const { deps, calls } = makeDeps({ due: [] });
    await gradeUserPagePicks("u1", [MLB, NFL, NBA], deps, WINDOW);
    expect("nothing due: exactly one gate query", calls.due, 1);
    expect("nothing due: no persist", calls.persist, []);
    expect("nothing due: no claim", calls.claim, []);
    expect("nothing due: no grade", calls.grade, []);
  }

  // ---- 2. Gate query shape: ONE round trip, window = now + drift ----
  {
    nextScenario();
    const seen: any[] = [];
    const original = prisma.sport.findMany;
    (prisma.sport as any).findMany = async (args: unknown) => {
      seen.push(args);
      return [{ name: "MLB" }, { name: "NFL" }];
    };
    try {
      const names = await sportNamesWithDuePendingPicks("user-42", new Date(clock));
      expect("gate query: exactly one prisma call", seen.length, 1);
      const some = seen[0]?.where?.picks?.some;
      expect("gate query: scoped to the user", some?.userId, "user-42");
      expect("gate query: PENDING only", some?.status, "PENDING");
      expect(
        "gate query: gameTime <= now + MAX_GAME_TIME_DRIFT_MS (6h)",
        some?.gameTime?.lte?.getTime(),
        clock + MAX_GAME_TIME_DRIFT_MS
      );
      expect("gate query: MAX_GAME_TIME_DRIFT_MS is 6h", MAX_GAME_TIME_DRIFT_MS, 6 * 3600000);
      expect("gate query: selects names only", seen[0]?.select, { name: true });
      expect("gate query: returns the sport-name set", [...names].sort(), ["MLB", "NFL"]);
    } finally {
      (prisma.sport as any).findMany = original;
    }
  }

  // ---- 3. Only sports the user has a due pick in do any work ----
  {
    nextScenario();
    const { deps, calls } = makeDeps({ due: ["MLB"] });
    await gradeUserPagePicks("u1", [MLB, NFL, NBA], deps, WINDOW);
    expect("due in MLB only: persist MLB only", calls.persist, [MLB]);
    expect("due in MLB only: grade MLB only", calls.grade, ["MLB|" + MLB]);
  }

  // ---- 4. /live scoping: a single-sport call ignores other due sports ----
  {
    nextScenario();
    const { deps, calls } = makeDeps({ due: ["MLB", "NFL"] });
    await gradeUserPagePicks("u1", [NFL], deps, WINDOW);
    expect("single-sport call: persists only that sport", calls.persist, [NFL]);
    expect("single-sport call: grades only that sport", calls.grade, ["NFL|" + NFL]);
  }

  // ---- 5. Throttle: many views in one window -> one persist, every view grades ----
  {
    nextScenario();
    const { deps, calls } = makeDeps({ due: ["MLB"] });
    for (let i = 0; i < 6; i++) {
      await gradeUserPagePicks("u1", [MLB], deps, WINDOW);
      clock += 5_000; // 30s total, inside the 45s window
    }
    expect("6 views inside one window: persist ran once", calls.persist.length, 1);
    expect("6 views inside one window: the viewer's picks graded every view", calls.grade.length, 6);

    clock += 60_000; // window rolled over
    await gradeUserPagePicks("u1", [MLB], deps, WINDOW);
    expect("first view after the window rolls: persist runs again", calls.persist.length, 2);
    expect("...and grades again", calls.grade.length, 7);
  }

  // ---- 6. Concurrent views on one instance share one in-flight persist ----
  {
    nextScenario();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps, calls } = makeDeps({ due: ["NBA"], persist: () => gate });
    const views = Array.from({ length: 5 }, () => gradeUserPagePicks("u1", [NBA], deps, WINDOW));
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all(views);
    expect("5 concurrent views: one persist", calls.persist.length, 1);
    expect("5 concurrent views: all 5 graded after it", calls.grade.length, 5);
  }

  // ---- 7. Losing the cross-instance claim: skip persist, still grade ----
  {
    nextScenario();
    const { deps, calls } = makeDeps({ due: ["MLB"], claim: false });
    await gradeUserPagePicks("u1", [MLB], deps, WINDOW);
    expect("claim lost: no persist", calls.persist, []);
    expect("claim lost: still grades against already-persisted results", calls.grade, ["MLB|" + MLB]);
  }

  // ---- 8. Persist failure must NOT skip grading, and is retried next view ----
  {
    nextScenario();
    let failNext = true;
    const { deps, calls } = makeDeps({
      due: ["MLB"],
      persist: async () => {
        if (failNext) throw new Error("score source down");
        return 1;
      },
    });
    let threw = false;
    try {
      await gradeUserPagePicks("u1", [MLB], deps, WINDOW);
    } catch {
      threw = true;
    }
    expect("persist rejects: the page call does not throw", threw, false);
    expect("persist rejects: grading STILL ran", calls.grade.length, 1);
    failNext = false;
    clock += 5_000; // same window
    await gradeUserPagePicks("u1", [MLB], deps, WINDOW);
    expect("persist retried on the next view (rejection is not memoized)", calls.persist.length, 2);
  }

  // ---- 9. Grade failure in one sport is swallowed and doesn't block another ----
  {
    nextScenario();
    const { deps, calls } = makeDeps({
      due: ["MLB", "NFL"],
      grade: async (_u, _n, sportKey) => {
        if (sportKey === MLB) throw new Error("boom");
        return {};
      },
    });
    let threw = false;
    try {
      await gradeUserPagePicks("u1", [MLB, NFL], deps, WINDOW);
    } catch {
      threw = true;
    }
    expect("grade rejects in one sport: page call does not throw", threw, false);
    expect("grade rejects in one sport: the other sport still graded", calls.grade.sort(), ["MLB|" + MLB, "NFL|" + NFL]);
  }

  // ---- 10. Gate query failure: best-effort, no throw, no work ----
  {
    nextScenario();
    const { deps, calls } = makeDeps({ due: new Error("db down") });
    let threw = false;
    try {
      await gradeUserPagePicks("u1", [MLB], deps, WINDOW);
    } catch {
      threw = true;
    }
    expect("gate query fails: does not throw", threw, false);
    expect("gate query fails: no persist / grade", [calls.persist.length, calls.grade.length], [0, 0]);
  }

  // ---- 11. throttledPersistFinalScores per-sport isolation ----
  {
    nextScenario();
    const { deps, calls } = makeDeps({});
    await throttledPersistFinalScores(MLB, deps, WINDOW);
    await throttledPersistFinalScores(NFL, deps, WINDOW);
    await throttledPersistFinalScores(MLB, deps, WINDOW);
    expect("throttle is per sport: MLB once, NFL once", calls.persist, [MLB, NFL]);
  }

  // ---- 12. Cron routes keep the RAW persistFinalScores; pages never call it ----
  {
    const src = (p: string) => readFileSync(p, "utf8");
    for (const route of ["src/app/api/cron/grade-picks/route.ts", "src/app/api/cron/refresh-scores/route.ts"]) {
      const s = src(route);
      expect(`${route}: imports persistFinalScores from grading`, /import \{[^}]*\bpersistFinalScores\b[^}]*\} from "@\/server\/data\/grading"/.test(s), true);
      expect(`${route}: calls persistFinalScores(sportKey) directly`, /persistFinalScores\(sportKey\)/.test(s), true);
      expect(`${route}: never touches the page-load throttle`, /page-grading|throttledPersistFinalScores|gradeUserPagePicks/.test(s), false);
    }
    expect(
      "grading.ts does not depend on page-grading (throttle lives only on the page path)",
      /page-grading/.test(src("src/server/data/grading.ts")),
      false
    );
    for (const page of ["src/app/(app)/picks/page.tsx", "src/app/(app)/live/[gameId]/page.tsx"]) {
      const s = src(page);
      expect(`${page}: uses gradeUserPagePicks`, /gradeUserPagePicks\(/.test(s), true);
      expect(
        `${page}: no direct persistFinalScores / gradePendingPicks / regradeFuzzyMatchedPicks`,
        /persistFinalScores|gradePendingPicks|regradeFuzzyMatchedPicks/.test(s),
        false
      );
    }
  }

  if (failures > 0) {
    console.log(`\n${failures} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll assertions passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
