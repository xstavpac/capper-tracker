// Query-counting tests read the statements a PrismaClient `query` log event reports.
// The library engine delivers those events through one native log callback, separate
// from the promise that resolves the query, so an event can reach `$on("query")` after
// the awaited call has returned. Read (or clear) the array straight after an `await`
// and a statement from that call is missing from the window it belongs to and shows up
// in the next one.
//
// drainQueryLog runs a uniquely marked sentinel statement through the same client and
// waits until the sentinel's own event arrives. The callback is a single FIFO queue and
// the sentinel is sent after every earlier call has returned, so by then the events of
// those calls have arrived too. The sentinel is removed from `queries`. A sentinel that
// never arrives throws; there is no retry and no fallback.
type RawClient = { $queryRawUnsafe: (sql: string) => Promise<unknown> };

let sentinelCount = 0;

export async function drainQueryLog(client: RawClient, queries: string[], timeoutMs = 10_000): Promise<void> {
  const marker = `query-log-drain-${process.pid}-${++sentinelCount}`;
  await client.$queryRawUnsafe(`SELECT '${marker}' AS marker`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const at = queries.findIndex((q) => q.includes(marker));
    if (at >= 0) {
      queries.splice(at, 1);
      return;
    }
    if (Date.now() > deadline) throw new Error(`drainQueryLog: the sentinel's query event did not arrive within ${timeoutMs} ms`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}
