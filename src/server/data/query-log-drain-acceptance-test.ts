// drainQueryLog (query-log-drain.ts), against a fake client - no database. The fake
// delivers log events late, the way the engine's log callback can: after the call
// that caused them has already returned.
//   node --require ./scripts/server-only-stub.cjs --import tsx src/server/data/query-log-drain-acceptance-test.ts
import { drainQueryLog } from "./query-log-drain";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${!pass && detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const markerOf = (sql: string) => /'([^']+)'/.exec(sql)?.[1] ?? "";

async function main() {
  // An earlier call's event is still in flight when the sentinel is sent; both arrive late, in order.
  const queries: string[] = [];
  setTimeout(() => queries.push("SELECT 1 /* earlier call */"), 5);
  const late = { $queryRawUnsafe: async (sql: string) => void setTimeout(() => queries.push(sql), 20) };
  await drainQueryLog(late, queries);
  check("a late event of an earlier call is in the window when drain returns", queries.length === 1 && queries[0] === "SELECT 1 /* earlier call */", JSON.stringify(queries));

  // Sentinels are unique, and each is removed from the log.
  const seen: string[] = [];
  const quick = { $queryRawUnsafe: async (sql: string) => void (seen.push(markerOf(sql)), queries.push(sql)) };
  await drainQueryLog(quick, queries);
  await drainQueryLog(quick, queries);
  check("two drains use two different markers", seen.length === 2 && seen[0] !== seen[1] && seen.every((m) => m.startsWith("query-log-drain-")), JSON.stringify(seen));
  check("the sentinels are removed from the log", queries.length === 1, JSON.stringify(queries));

  // A sentinel whose event never arrives is an error, not a silent pass.
  const never = { $queryRawUnsafe: async () => undefined };
  const started = Date.now();
  let message = "";
  await drainQueryLog(never, [], 150).catch((e: Error) => (message = e.message));
  check("a sentinel that never arrives throws after the timeout", /did not arrive within 150 ms/.test(message) && Date.now() - started >= 150, message);

  // A failing sentinel query surfaces its own error.
  const broken = { $queryRawUnsafe: async () => Promise.reject(new Error("db down")) };
  let brokenMessage = "";
  await drainQueryLog(broken, []).catch((e: Error) => (brokenMessage = e.message));
  check("a failing sentinel query rejects with its error", brokenMessage === "db down", brokenMessage);
}

main()
  .catch((err) => {
    console.error("FAIL: unexpected error", err);
    failures++;
  })
  .finally(() => process.exit(failures ? 1 : 0));
