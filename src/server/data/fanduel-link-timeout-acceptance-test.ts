// Send to FanDuel always ends (server/data/fanduel-link.ts): a 25-leg send resolves, an Odds API call that never
// answers times out into a per-leg error instead of holding the send, a re-tap after a timeout does not reuse the
// stuck promise, a game whose main-market call failed gets no alternate-market call, and a 14-leg send is unchanged.
// Once a send's deadline has passed, no call queued behind it fires - even when the clock still reads 1 ms short of the
// deadline as the timers due at it fire (Linux CI does that: timers run on the loop's monotonic clock, the deadline is
// read from Date.now) - and one send's deadline never cuts another send's calls short.
// Upstream is a stubbed fetch (a "hang" ignores the abort signal, the worst case); no DB. Answers are held until the
// test releases them (drive below), never on a fixed delay. Run with:
//   node --require ./scripts/server-only-stub.cjs --import tsx src/server/data/fanduel-link-timeout-acceptance-test.ts
export {};
process.env.ODDS_API_KEY = "test-key";
// Never write the usage-log rows this exercises to a real database.
delete process.env.DATABASE_URL;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : ` -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const HOME = "Boston Celtics";
const AWAY = "New York Knicks";
const DAY = 24 * 60 * 60 * 1000;

// One scenario = n games (same two teams, one per day, so the event is told apart by its time) under its own id
// prefix and its own "now" (the 60 s caches are keyed by id / expire by now, so scenarios never share an answer).
let scenarioNo = 0;
function scenario(n: number) {
  const prefix = "s" + ++scenarioNo + "e";
  const now = new Date(Date.parse("2026-11-08T12:00:00Z") + scenarioNo * 10 * 60 * 1000);
  const start = (i: number) => new Date(now.getTime() + (i + 1) * DAY).toISOString();
  const legs = Array.from({ length: n }, (_, i) => ({
    pickId: "p" + i,
    sportKey: "basketball_nba",
    leagueName: "NBA",
    betType: "MONEYLINE",
    period: "FULL_GAME",
    betDetail: HOME + " ML " + i,
    pickedSide: "HOME",
    line: null,
    homeTeam: HOME,
    awayTeam: AWAY,
    gameTime: start(i),
    odds: -150,
    oddsSource: "STATED",
    onBoard: true,
  })) as import("@/lib/parlay/fanduel-link").FanDuelLegInput[];
  const events = Array.from({ length: n }, (_, i) => ({ id: prefix + i, home_team: HOME, away_team: AWAY, commence_time: start(i) }));
  return { prefix, now, legs, events };
}
const link = (m: string, s: string) => `https://sportsbook.fanduel.com/addToBetslip?marketId=${m}&selectionId=${s}`;
const oddsFor = (id: string) => {
  const n = id.replace(/[^0-9]/g, "");
  return {
  bookmakers: [
    {
      key: "fanduel",
      markets: [
        {
          key: "h2h",
          outcomes: [
            { name: HOME, price: -150, sid: n + "1", link: link(n + ".1", n + "1") },
            { name: AWAY, price: 130, sid: n + "2", link: link(n + ".1", n + "2") },
          ],
        },
      ],
    },
  ],
  };
};

let events: unknown[] = [];
let hangOn = (_id: string) => false;
let marketCalls: string[] = [];
let live = 0;
let peak = 0;
// Answers the test holds and releases (drive), so nothing here waits on a fixed delay. A held call stays in flight -
// holding its slot - until drive releases it, which is what makes the in-flight peak observable.
let held: (() => void)[] = [];
let wake: (() => void) | null = null;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  const m = /\/events\/([^/]+)\/odds/.exec(url);
  if (!m) return json(events);
  const id = decodeURIComponent(m[1]);
  marketCalls.push(id);
  live++;
  peak = Math.max(peak, live);
  try {
    if (hangOn(id)) return await new Promise<Response>(() => {}); // never answers, ignores the abort signal
    await new Promise<void>((release) => {
      held.push(release);
      wake?.();
    });
    return json(oddsFor(id));
  } finally {
    live--;
  }
}) as typeof fetch;
console.log = ((orig) => (...a: unknown[]) => {
  const line = a.map(String).join(" ");
  if (/^(PASS|FAIL|all checks|\d+ check)/.test(line)) orig(line);
})(console.log);
console.warn = () => {};
// Runs a send to its end, releasing every held answer as calls arrive. No polling: it sleeps until either a call
// arrives (the stub wakes it) or the send settles.
async function drive<T>(p: Promise<T>): Promise<T> {
  let done = false;
  const settled = p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    }
  );
  while (!done) {
    if (held.length > 0) {
      const batch = held;
      held = [];
      batch.forEach((release) => release());
      await Promise.resolve();
      continue;
    }
    await Promise.race([settled, new Promise<void>((r) => (wake = r))]);
    wake = null;
  }
  return p;
}
console.error = () => {};

async function main() {
  const { oddsApiDeps, fanDuelFetchTuning } = await import("@/server/data/fanduel-link");
  const { buildFanDuelLink } = await import("@/lib/parlay/fanduel-link");
  fanDuelFetchTuning.retryDelayMs = 0;
  const send = (s: ReturnType<typeof scenario>, startedAt = Date.now()) => drive(buildFanDuelLink(s.legs, oddsApiDeps(s.now, startedAt)));
  const realClock = fanDuelFetchTuning.now;
  const reset = () => {
    marketCalls = [];
    peak = 0;
    hangOn = () => false;
    fanDuelFetchTuning.now = realClock;
  };

  // ---- 25 legs resolve ----
  reset();
  let s = scenario(25);
  events = s.events;
  let t = Date.now();
  let r = await send(s);
  check("25 legs: every leg matched", r.legs.filter((l) => l.status === "matched").length, 25);
  check("...25 event calls (one per game), never more than 4 in flight", [marketCalls.length, peak <= 4], [25, true]);
  check("...the link holds all 25", r.url === null ? 0 : new URL(r.url).searchParams.getAll("marketId[24]").length, 1);
  check("...and finishes promptly", Date.now() - t < 5000, true);

  // ---- 14 legs: unchanged ----
  reset();
  s = scenario(14);
  events = s.events;
  r = await send(s);
  check("14 legs: all matched, 14 calls, link holds 14", [r.legs.filter((l) => l.status === "matched").length, marketCalls.length, new URL(r.url!).searchParams.getAll("marketId[13]").length], [14, 14, 1]);

  // ---- a hanging event call times out into a per-leg error ----
  fanDuelFetchTuning.callTimeoutMs = 80;
  reset();
  s = scenario(25);
  events = s.events;
  const stuck = s.prefix + "3";
  hangOn = (id) => id === stuck;
  t = Date.now();
  r = await send(s);
  const by = Object.fromEntries(r.legs.map((l) => [l.pickId, l]));
  check("hanging call: the send resolved in about the call timeout, not never", Date.now() - t < 2000, true);
  check("...that leg is an error saying it took too long", [by.p3.status, /too long/.test(by.p3.reason ?? "")], ["error", true]);
  check("...the other 24 are matched, and the link holds them", [r.legs.filter((l) => l.status === "matched").length, new URL(r.url!).searchParams.getAll("marketId[23]").length], [24, 1]);
  check("...the timed-out call was not retried (1 call for it)", marketCalls.filter((id) => id === stuck).length, 1);

  // ---- re-tap after a timeout: a fresh call, not the stuck promise ----
  hangOn = () => false;
  t = Date.now();
  r = await send(s);
  check("re-tap: the stuck leg is matched now", r.legs.find((l) => l.pickId === "p3")!.status, "matched");
  check("...by a second call for that event (the stuck promise was dropped, not reused)", marketCalls.filter((id) => id === stuck).length, 2);
  check("...and the 24 good answers came from the cache (no new calls for them)", marketCalls.length, 25 + 1);
  check("...without waiting", Date.now() - t < 1000, true);

  // ---- the whole-send deadline: calls reached after it fail at once ----
  fanDuelFetchTuning.callTimeoutMs = 8000;
  fanDuelFetchTuning.deadlineMs = 150;
  reset();
  s = scenario(25);
  events = s.events;
  hangOn = () => true;
  t = Date.now();
  r = await send(s);
  check("every call hangs: the send still resolves within the deadline", Date.now() - t < 1500, true);
  check("...all 25 legs are errors, none matched, no link", [r.legs.filter((l) => l.status === "error" && /too long/.test(l.reason ?? "")).length, r.url], [25, null]);
  check("...calls queued behind the stuck ones were never fired once the deadline passed", marketCalls.length <= 4, true);

  // ---- the same, with the clock still 1 ms short of the deadline when the timers due at it fire ----
  // The worst case Linux CI produced: the four stuck calls' timers fire, their slots go to the queued calls, and
  // Date.now() still reads deadline - 1, so "time left" alone says 1 ms. Pinning the clock there makes it so on any
  // machine (Windows timers fire late, which hid it locally); only the send's own "deadline passed" can stop them.
  reset();
  s = scenario(25);
  events = s.events;
  hangOn = () => true;
  t = Date.now();
  let deadlineAt = t + fanDuelFetchTuning.deadlineMs;
  fanDuelFetchTuning.now = () => Math.min(Date.now(), deadlineAt - 1);
  r = await send(s, t);
  check("clock 1 ms short at the deadline: the send still resolves, all 25 legs too long", [Date.now() - t < 1500, r.legs.filter((l) => l.status === "error" && /too long/.test(l.reason ?? "")).length], [true, 25]);
  check("...and no queued call was fired after the deadline (only the first 4)", marketCalls.length <= 4, true);

  // ---- two sends at once: one send's deadline never cuts the other's calls ----
  // Send A (25 legs, every call hangs, deadline 150 ms) holds all four slots; send B (1 leg, answers, deadline a
  // second later) queues behind A's legs. When A's deadline passes, A's queued calls give up, and B's call - next in
  // line - must still fire and match, because A's "deadline passed" is A's alone. Same pinned clock as above.
  reset();
  const A = scenario(25);
  const bTime = new Date(Date.parse(A.events[24].commence_time) + DAY).toISOString();
  const B = { ...A, legs: [{ ...A.legs[0], pickId: "b0", gameTime: bTime }] };
  const bEvent = { id: "b" + A.prefix + "0", home_team: HOME, away_team: AWAY, commence_time: bTime };
  events = [...A.events, bEvent];
  hangOn = (id) => id.startsWith(A.prefix);
  t = Date.now();
  deadlineAt = t + fanDuelFetchTuning.deadlineMs;
  fanDuelFetchTuning.now = () => Math.min(Date.now(), deadlineAt - 1);
  const [ra, rb] = await Promise.all([send(A, t), send(B, t + 1000)]);
  check("two sends: A's 25 legs are all too long, and A fired no call after its deadline", [ra.legs.filter((l) => l.status === "error" && /too long/.test(l.reason ?? "")).length, marketCalls.filter((id) => id.startsWith(A.prefix)).length <= 4], [25, true]);
  check("...B's call still fired once A's deadline passed, and B's leg matched", [marketCalls.filter((id) => id === bEvent.id).length, rb.legs[0].status], [1, "matched"]);

  // ---- a failed main call asks for no alternate market ----
  fanDuelFetchTuning.deadlineMs = 25000;
  fanDuelFetchTuning.callTimeoutMs = 80;
  reset();
  s = scenario(1);
  events = s.events;
  s.legs[0] = { ...s.legs[0], betType: "PLAYER_PROP", betDetail: "Jayson Tatum Over 27.5 Points", playerName: "Jayson Tatum", propMarket: "POINTS", pickedSide: null, line: 27.5 } as typeof s.legs[0];
  hangOn = () => true;
  r = await send(s);
  check("a prop leg whose main-market call timed out: error, and exactly one call (no alternate-market call)", [r.legs[0].status, marketCalls.length], ["error", 1]);

  if (failures > 0) {
    console.log(failures + " check(s) failed");
    process.exit(1);
  }
  console.log("all checks passed");
  process.exit(0);
}
main();
