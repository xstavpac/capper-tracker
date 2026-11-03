// Proof for Option D - the posted-line and capper-history signals that settle a shared
// school's NCAAF / NCAAB question when a single-line batch gives the card nothing to read.
//   npx tsx src/lib/college-option-d-acceptance-test.ts
//
// No test framework in this repo. console.logs PASS/FAIL, exits non-zero on any failure.
// No DB, no network: the posted lines and the history are injected fakes. The history
// query's SQL is pinned as text here; running it is the DB-backed test (asked for
// separately). The prompt-rate section at the end uses a SYNTHETIC posted-line table
// (the fixture's lines are made up and carry no real posted lines): it proves the
// mechanics and sensitivity, not the real-world hit rate.

import { readFileSync } from "node:fs";
import { NCAAB_LISTED_TEAMS } from "@/lib/college-teams";
import { parseCatalog, withCollegeCandidates, type ParsedPick } from "@/lib/parse-catalog";
import { runAmbiguousHierarchy, type ScheduleChecker } from "@/lib/ambiguous-hierarchy";
import {
  COLLEGE_LINE_TOLERANCE,
  historyLeague,
  lineVerdict,
  postedLinesForSchool,
  type CapperLeagueHistory,
  type CollegeLineQuery,
  type PostedCollegeLines,
  type PostedLinesByTeam,
} from "@/lib/college-line-signal";
import { PROMPT_RATE_GAMES, PROMPT_RATE_SAMPLES, type PromptRateCard } from "@/lib/ncaab-prompt-rate-fixture";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

const IN_OVERLAP = new Date("2026-11-10T17:00:00Z");
const parse = (lines: string[]) => parseCatalog("Sharp\n" + lines.join("\n") + "\n", ["Sharp"], undefined, NCAAB_LISTED_TEAMS);
const schedule = (playing: string[]): ScheduleChecker => async (queries) =>
  Object.fromEntries(queries.map((q) => [q.nickname + "|" + q.sport, playing.includes(q.nickname + "|" + q.sport)]));
const outcome = (p: ParsedPick) => (p.ambiguous ? "PROMPT " + p.ambiguous.map((o) => o.sport).join("/") : p.sportName);

type Posted = Partial<Record<"NCAAF" | "NCAAB", Partial<PostedCollegeLines>>>;
type Run = { outcomes: string[]; methods: string[]; lineCalls: number; historyCalls: number; historyAsked: string[][] };

// Both leagues play (so the schedule step cannot decide), then Option D gets its turn.
async function run(
  lines: string[],
  opts: { posted?: Posted; history?: CapperLeagueHistory; lineFails?: boolean; historyFails?: boolean; noDeps?: boolean } = {}
): Promise<Run> {
  const res: Run = { outcomes: [], methods: [], lineCalls: 0, historyCalls: 0, historyAsked: [] };
  const log = console.log;
  console.log = () => {};
  const picks = parse(lines).picks;
  const both = Array.from(new Set(withCollegeCandidates([...picks]).flatMap((p) => (p.ambiguous ?? []).map((o) => o.nickname + "|" + o.sport))));
  const out = await runAmbiguousHierarchy(picks, {}, {
    runScheduleCheck: schedule(both),
    runWideScheduleCheck: schedule(both),
    now: IN_OVERLAP,
    ...(opts.noDeps
      ? {}
      : {
          runCollegeLineCheck: async (queries: CollegeLineQuery[]) => {
            res.lineCalls++;
            if (opts.lineFails) throw new Error("odds unavailable");
            const table: PostedLinesByTeam = {};
            for (const q of queries) {
              const p = opts.posted?.[q.sport as "NCAAF" | "NCAAB"];
              if (p) table[q.nickname + "|" + q.sport] = { spread: p.spread ?? null, total: p.total ?? null };
            }
            return table;
          },
          getCapperLeagueHistory: async (names: string[]) => {
            res.historyCalls++;
            res.historyAsked.push(names);
            if (opts.historyFails) throw new Error("db down");
            return opts.history ?? {};
          },
        }),
  });
  console.log = log;
  res.outcomes = out.picks.map(outcome);
  res.methods = out.logs.map((l) => l.method);
  return res;
}

const lopsided = (league: "NCAAF" | "NCAAB", n = 20): CapperLeagueHistory => ({ sharp: league === "NCAAF" ? { NCAAF: n, NCAAB: 0 } : { NCAAF: 0, NCAAB: n } });

async function main() {
  // ---- Pure pieces ----
  check("tolerance is 1.5", COLLEGE_LINE_TOLERANCE, 1.5);
  check("history: 10 picks at exactly 90% resolves", historyLeague({ NCAAF: 9, NCAAB: 1 }), "NCAAF");
  check("history: 85% of 20 does not", historyLeague({ NCAAF: 17, NCAAB: 3 }), null);
  check("history: 100% of 9 picks does not", historyLeague({ NCAAF: 0, NCAAB: 9 }), null);
  check("history: no row at all does not", historyLeague(undefined), null);
  const opts = [
    { nickname: "duke", sport: "NCAAF" },
    { nickname: "duke", sport: "NCAAB" },
  ] as never;
  const totalPick = { ambiguousBetType: "TOTAL", ambiguousLine: 140.5, ambiguousPartialGame: false } as const;
  check(
    "total: compared with the posted game total, one league within 1.5",
    lineVerdict(totalPick, opts, { "duke|NCAAF": { spread: -3, total: 55.5 }, "duke|NCAAB": { spread: -3, total: 141.5 } }),
    { kind: "resolved", sport: "NCAAB" }
  );
  check(
    "team total never uses the line signal",
    lineVerdict({ ...totalPick, ambiguousBetType: "TEAM_TOTAL" }, opts, { "duke|NCAAF": { spread: 0, total: 1 }, "duke|NCAAB": { spread: 0, total: 140.5 } }),
    { kind: "not_applicable" }
  );
  check(
    "a pick with no parsed line (pick'em) is not applicable",
    lineVerdict({ ...totalPick, ambiguousBetType: "SPREAD", ambiguousLine: null }, opts, {}),
    { kind: "not_applicable" }
  );

  // Posted lines out of a board: the school's own side, first book, next game only.
  const board = [
    {
      homeTeam: "Duke Blue Devils",
      awayTeam: "Wake Forest Demon Deacons",
      commenceTime: "2026-11-12T00:00:00Z",
      bookmakers: [
        { markets: [{ key: "h2h", outcomes: [] }] },
        {
          markets: [
            { key: "spreads", outcomes: [{ name: "Duke Blue Devils", point: -4.5 }, { name: "Wake Forest Demon Deacons", point: 4.5 }] },
            { key: "totals", outcomes: [{ name: "Over", point: 141.5 }, { name: "Under", point: 141.5 }] },
          ],
        },
      ],
    },
    { homeTeam: "Duke Blue Devils", awayTeam: "Elon Phoenix", commenceTime: "2026-11-09T00:00:00Z", bookmakers: [] }, // already started
  ];
  check("board: the school's own spread outcome and the game total", postedLinesForSchool(board, "duke blue devils", "basketball_ncaab", IN_OVERLAP), { spread: -4.5, total: 141.5 });
  check("board: the opponent's side reads its own signed point", postedLinesForSchool(board, "wake forest demon deacons", "basketball_ncaab", IN_OVERLAP), { spread: 4.5, total: 141.5 });
  check("board: a school with no upcoming game has no line", postedLinesForSchool(board, "kentucky", "basketball_ncaab", IN_OVERLAP), null);

  // ---- Hierarchy: line signal ----
  const posted = (f: number | null, b: number | null): Posted => ({ NCAAF: { spread: f }, NCAAB: { spread: b } });
  const sp = async (line: string, p: Posted, extra = {}) => (await run(["Duke " + line], { posted: p, ...extra }));
  check("spread: only the NCAAF line within 1.5 -> NCAAF", (await sp("-4.5", posted(-4, -9))).outcomes, ["NCAAF"]);
  check("spread: only the NCAAB line within 1.5 -> NCAAB, logged as line_vs_posted", [(await sp("-4.5", posted(-9, -5))).outcomes, (await sp("-4.5", posted(-9, -5))).methods], [["NCAAB"], ["line_vs_posted"]]);
  check("spread: exactly 1.5 away counts as within", (await sp("-4.5", posted(-3, -9))).outcomes, ["NCAAF"]);
  check("spread: 1.6 away does not (neither within) -> prompt", (await sp("-4.5", posted(-2.9, -9))).outcomes, ["PROMPT NCAAF/NCAAB"]);
  check("spread: both leagues within tolerance -> prompt", (await sp("-4.5", posted(-4, -5))).outcomes, ["PROMPT NCAAF/NCAAB"]);
  check("spread: the other side of the number (+4.5 vs posted -4.5) is not within", (await sp("+4.5", posted(-4.5, -9))).outcomes, ["PROMPT NCAAF/NCAAB"]);
  check("spread: a league with no posted line -> prompt, even when the other is within", (await sp("-4.5", { NCAAF: { spread: -4.5 } })).outcomes, ["PROMPT NCAAF/NCAAB"]);
  check("spread: no lines at all -> falls through to the prompt", (await sp("-4.5", {})).outcomes, ["PROMPT NCAAF/NCAAB"]);
  check("spread: the posted-line lookup failing -> prompt", (await sp("-4.5", posted(-4.5, -9), { lineFails: true })).outcomes, ["PROMPT NCAAF/NCAAB"]);
  check("without the new lookups the hierarchy answers exactly as before", (await sp("-4.5", posted(-4.5, -9), { noDeps: true })).outcomes, ["PROMPT NCAAF/NCAAB"]);
  check("partial game (first half) skips the line signal", (await run(["Duke 1H -2.5"], { posted: posted(-2.5, -9) })).outcomes, ["PROMPT NCAAF/NCAAB"]);
  check("a pro candidate on the list is not a college question", (await run(["Houston -11"], { posted: posted(-11, -30) })).outcomes[0].startsWith("PROMPT"), true);

  // ---- Hierarchy: history as the moneyline signal ----
  const ml = (history?: CapperLeagueHistory) => run(["Duke ML"], { history });
  check("moneyline: lopsided NCAAB history -> NCAAB, logged as capper_history", [(await ml(lopsided("NCAAB"))).outcomes, (await ml(lopsided("NCAAB"))).methods], [["NCAAB"], ["capper_history"]]);
  check("moneyline: lopsided NCAAF history -> NCAAF", (await ml(lopsided("NCAAF"))).outcomes, ["NCAAF"]);
  check("moneyline: 85% (17 of 20) -> prompt", (await ml({ sharp: { NCAAF: 17, NCAAB: 3 } })).outcomes, ["PROMPT NCAAF/NCAAB"]);
  check("moneyline: 8 picks, all one league -> prompt", (await ml(lopsided("NCAAB", 8))).outcomes, ["PROMPT NCAAF/NCAAB"]);
  check("moneyline: no history -> prompt", (await ml({})).outcomes, ["PROMPT NCAAF/NCAAB"]);
  check("moneyline: history lookup failing -> prompt", (await run(["Duke ML"], { historyFails: true })).outcomes, ["PROMPT NCAAF/NCAAB"]);
  check("moneyline never asks for posted lines", (await ml(lopsided("NCAAB"))).lineCalls, 0);

  // ---- Hierarchy: history as the spread / total fallback ----
  const fb = (line: string, p: Posted, history?: CapperLeagueHistory) => run(["Duke " + line], { posted: p, history });
  check("fallback: both within tolerance + lopsided history -> resolves", (await fb("-4.5", posted(-4, -5), lopsided("NCAAB"))).outcomes, ["NCAAB"]);
  check("fallback: neither within + lopsided history -> resolves", (await fb("-4.5", posted(-9, -12), lopsided("NCAAF"))).outcomes, ["NCAAF"]);
  check("fallback: a league with no posted line + lopsided history -> resolves", (await fb("-4.5", { NCAAF: { spread: -4.5 } }, lopsided("NCAAB"))).outcomes, ["NCAAB"]);
  check("fallback: inconclusive line + thin history -> prompt", (await fb("-4.5", posted(-4, -5), lopsided("NCAAB", 8))).outcomes, ["PROMPT NCAAF/NCAAB"]);
  check("fallback: inconclusive line + 85% history -> prompt", (await fb("-4.5", posted(-4, -5), { sharp: { NCAAF: 3, NCAAB: 17 } })).outcomes, ["PROMPT NCAAF/NCAAB"]);
  const resolvedA = await fb("-4.5", posted(-4.5, -12), lopsided("NCAAB"));
  check("line resolved NCAAF + history NCAAB -> stays NCAAF", resolvedA.outcomes, ["NCAAF"]);
  check("line resolved: history is not consulted at all", resolvedA.historyCalls, 0);
  check("fallback: the history is asked only for the capper with an open pick, lowercased", (await fb("-4.5", posted(-4, -5), lopsided("NCAAB"))).historyAsked, [["sharp"]]);
  check("a partial game never falls back to history", (await run(["Duke 1H -2.5"], { posted: posted(-2.5, -2.5), history: lopsided("NCAAB") })).outcomes, ["PROMPT NCAAF/NCAAB"]);

  // ---- Line vs the capper's block: a disagreement stays a prompt, history not consulted ----
  const conflict = await run(["Gonzaga -3", "Duke -4.5"], { posted: posted(-4.5, -12), history: lopsided("NCAAB") });
  check("line says NCAAF, the block says NCAAB -> prompt, and history does not break the tie", conflict.outcomes, ["NCAAB", "PROMPT NCAAF/NCAAB"]);
  check("... history was not asked", conflict.historyCalls, 0);
  const agree = await run(["Gonzaga -3", "Duke -4.5"], { posted: posted(-12, -4.5) });
  check("line and the block agree on NCAAB -> resolves", agree.outcomes, ["NCAAB", "NCAAB"]);

  // ---- The history query is scoped as designed (text pin; running it is the DB-backed test) ----
  const src = readFileSync("src/server/data/catalog-disambiguation-checks.ts", "utf8").replace(/\r\n/g, "\n");
  const sql = src.slice(src.indexOf("export async function runCapperLeagueHistory"));
  check("history sql: the importing user's own picks and cappers", [sql.includes('p."userId" = ${userId}'), sql.includes('c."userId" = ${userId}')], [true, true]);
  check("history sql: recipient copies excluded", sql.includes('p."isRecipientCopy" = false'), true);
  check("history sql: graded rows only, 30-day window, the two college sports", [sql.includes("p.status IN ('WIN', 'LOSS', 'PUSH')"), sql.includes('p."gameTime" >= ${since}'), sql.includes("s.name IN ('NCAAF', 'NCAAB')")], [true, true, true]);
  check("history sql: grouped in Postgres, no raw pick rows", sql.includes("GROUP BY 1, 2"), true);

  // ---- Prompt rate: synthetic posted lines + synthetic history ----
  // Real schedules from the fixture decide who plays; the posted lines are made up. The
  // pick's own league is posted at the pick's line (stale = a capper's line left behind or
  // an alt line, shifted 2-4 points away); the other league lands within 1.5 with probability
  // `collision`, else 2-8 away. Seeded by the line text, so nested across collision rates.
  const etDay = (iso: string) => new Date(Date.parse(iso) - 5 * 3600e3).toISOString().slice(0, 10);
  const hash = (s: string) => {
    let h = 2166136261;
    for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return ((h >>> 0) % 100000) / 100000;
  };
  type Synth = { collision: number; stale: number; history: "none" | "lopsided" };
  const rate = async (nowIso: string, cards: Record<string, PromptRateCard>[], synth: Synth) => {
    const now = new Date(nowIso);
    const today = etDay(nowIso);
    const shift = (d: number) => new Date(Date.parse(today + "T12:00:00Z") + d * 864e5).toISOString().slice(0, 10);
    const windowed = (ahead: (league: string) => number) => PROMPT_RATE_GAMES.filter(([league, start]) => etDay(start) >= shift(-1) && etDay(start) <= shift(ahead(league)));
    const checker = (games: typeof PROMPT_RATE_GAMES): ScheduleChecker => async (queries) =>
      Object.fromEntries(
        queries.map((q) => [
          q.nickname + "|" + q.sport,
          games.some(
            ([league, start, home, away]) =>
              league === q.sport && (!q.upcomingOnly || Date.parse(start) > now.getTime()) && (home.toLowerCase().endsWith(q.nickname) || away.toLowerCase().endsWith(q.nickname))
          ),
        ])
      );
    const near = windowed(() => 1);
    const wide = windowed((league) => (league === "NCAAF" || league === "NFL" ? 7 : 2));
    const out = { lines: 0, prompts: 0, wrong: [] as string[] };
    const log = console.log;
    console.log = () => {};
    for (const card of cards) {
      const names = Object.keys(card);
      const text = names.map((name) => name + "\n" + card[name].lines.join("\n")).join("\n\n") + "\n";
      const parsed = parseCatalog(text, names, undefined, NCAAB_LISTED_TEAMS);
      // The synthetic table, per school nickname, from the picks as the hierarchy will see them.
      const table: PostedLinesByTeam = {};
      for (const p of withCollegeCandidates([...parsed.picks])) {
        const truth = card[p.capperName].truth;
        if (!p.ambiguous || truth === "PRO" || p.ambiguousBetType !== "SPREAD" || p.ambiguousLine == null) continue;
        const staleShift = hash("stale" + p.raw) < synth.stale ? (hash("dir" + p.raw) < 0.5 ? -1 : 1) * (2 + Math.round(hash("amt" + p.raw) * 4) / 2) : 0;
        const otherNear = hash("coll" + p.raw) < synth.collision;
        const otherOff = otherNear ? (Math.round(hash("near" + p.raw) * 6) - 3) / 2 : (hash("dir2" + p.raw) < 0.5 ? -1 : 1) * (2 + Math.round(hash("far" + p.raw) * 12) / 2);
        for (const o of p.ambiguous) {
          if (o.sport !== "NCAAF" && o.sport !== "NCAAB") continue;
          table[o.nickname + "|" + o.sport] = { spread: o.sport === truth ? p.ambiguousLine + staleShift : p.ambiguousLine + otherOff, total: null };
        }
      }
      const history: CapperLeagueHistory =
        synth.history === "lopsided"
          ? Object.fromEntries(names.filter((n) => card[n].truth !== "PRO").map((n) => [n.toLowerCase(), { NCAAF: card[n].truth === "NCAAF" ? 20 : 0, NCAAB: card[n].truth === "NCAAB" ? 20 : 0 }]))
          : {};
      const res = await runAmbiguousHierarchy(parsed.picks, {}, {
        runScheduleCheck: checker(near),
        runWideScheduleCheck: checker(wide),
        runCollegeLineCheck: async (queries) => Object.fromEntries(queries.filter((q) => table[q.nickname + "|" + q.sport]).map((q) => [q.nickname + "|" + q.sport, table[q.nickname + "|" + q.sport]])),
        getCapperLeagueHistory: async () => history,
        now,
      });
      for (const p of res.picks) {
        out.lines++;
        const truth = card[p.capperName].truth;
        if (p.ambiguous) out.prompts++;
        else if (truth === "PRO" ? p.sportName === "NCAAF" || p.sportName === "NCAAB" : p.sportName !== truth) out.wrong.push(p.raw + " => " + p.sportName);
      }
      out.lines += parsed.unresolved.length;
    }
    console.log = log;
    return out;
  };
  const variants: [string, Synth][] = [
    ["no D (no lines, no history)", { collision: 1, stale: 0, history: "none" }],
    ["line 20% collision, no history", { collision: 0.2, stale: 0, history: "none" }],
    ["line 30% collision, no history", { collision: 0.3, stale: 0, history: "none" }],
    ["line 40% collision, no history", { collision: 0.4, stale: 0, history: "none" }],
    ["line 30% collision + lopsided history", { collision: 0.3, stale: 0, history: "lopsided" }],
    ["line 30% collision + 3% stale lines + lopsided history", { collision: 0.3, stale: 0.03, history: "lopsided" }],
    ["line 30% collision + 15% stale lines, no history", { collision: 0.3, stale: 0.15, history: "none" }],
  ];
  const results: Record<string, { prompts: number; lines: number; wrong: number }> = {};
  for (const day of ["Tue", "Sat"] as const) {
    const { now, cards } = PROMPT_RATE_SAMPLES[day];
    const oneAtATime = Object.entries(cards).flatMap(([name, card]) => card.lines.map((line) => ({ [name]: { truth: card.truth, lines: [line] } })));
    for (const [label, synth] of variants) {
      for (const [mode, sets] of [["paste", [cards]], ["single-line", oneAtATime]] as [string, Record<string, PromptRateCard>[]][]) {
        let prompts = 0;
        let lines = 0;
        const wrong: string[] = [];
        for (const set of sets) {
          const r = await rate(now, [set], synth);
          prompts += r.prompts;
          lines += r.lines;
          wrong.push(...r.wrong);
        }
        results[`${day} ${mode} | ${label}`] = { prompts, lines, wrong: wrong.length };
        console.log(`RATE ${day} ${mode} | ${label}: ${prompts}/${lines} prompts; silently wrong ${wrong.length}${wrong.length ? " (" + wrong.join(", ") + ")" : ""}`);
      }
    }
  }
  const base = (k: string) => results[k].prompts;
  check(
    "synthetic: D never adds a prompt (single-line, every variant at or under the no-D count)",
    variants.every(([label]) => ["Tue", "Sat"].every((d) => base(`${d} single-line | ${label}`) <= base(`${d} single-line | no D (no lines, no history)`))),
    true
  );
  check("synthetic: no stale lines, no misroutes", variants.filter(([, s]) => s.stale === 0).every(([label]) => ["Tue", "Sat"].every((d) => ["paste", "single-line"].every((m) => results[`${d} ${m} | ${label}`].wrong === 0))), true);

  if (failures > 0) {
    console.log(`${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log("ALL CHECKS PASSED");
}

main();
