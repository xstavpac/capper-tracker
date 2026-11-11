// Proof that persistFinalScores' team-trend ledger fields (GameResult.favTeam /
// totalLine) come from the snapshot row that actually holds the game, and that
// the score feed's spelling is matched with the sport's alias rows.
//
// The bug: grading read today's ET snapshot for every final. Every snapshot
// write keeps only games that have not started, so a game is only in its own ET
// day's row. A 9pm ET tip that goes final after ET midnight was graded against
// the next day's row, found nothing, and got favTeam / totalLine = null
// (~20 of 23 NBA and 10 of 11 NHL games starting 9pm ET+ over 10 days). The
// pricing side had the same bug and was fixed in #445 (pastSnapshotDateFor);
// grading now uses the same rule (ledgerFieldsForFinal). Separately,
// deriveLedgerFields called teamNamesMatch without the sport key, so the
// NCAAB / NCAAF / "LA Clippers" alias rows never applied.
//
// Pinned here:
//   1. a late-night game from an earlier ET day reads ITS day's row (loader
//      called with that day) and gets favTeam + totalLine from it; today's row
//      is never read for it, and a same-teams game in today's row is not used.
//   2. a game on today's ET day reads today's row exactly as before (loader
//      called with the sport key alone - no second argument).
//   3. NCAAB and NCAAF: a score-feed spelling that only matches the Odds API's
//      through the alias table gets its ledger fields; the same lookup with no
//      sport key (the old call) finds nothing. NBA "LA Clippers" too.
//   4. one run's loader reads each (sport, day) row once however many finals
//      share it.
//   5. persistFinalScores still gates on `!existing || existing.favTeam === null`
//      and only writes ledger fields when there is data (structural check).
//
// No DB, no network. Run with:
//   npx tsx src/server/data/grading-ledger-snapshot-day-acceptance-test.ts
// Exits non-zero on any failed assertion.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveLedgerFields, ledgerFieldsForFinal } from "@/server/data/grading";
import { createRequestOddsLoader, pastSnapshotDateFor, type OddsGame, type OddsLoader } from "@/server/data/odds";
import { easternDateKey } from "@/lib/dates";

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${pass ? "" : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!pass) failures++;
}

function oddsGame(
  sportKey: string,
  id: string,
  homeTeam: string,
  awayTeam: string,
  commenceTime: string,
  homePrice: number,
  awayPrice: number,
  total: number
): OddsGame {
  return {
    id,
    sportKey,
    homeTeam,
    awayTeam,
    commenceTime,
    bookmakers: [
      {
        key: "fanduel",
        title: "FanDuel",
        markets: [
          { key: "h2h", outcomes: [{ name: homeTeam, price: homePrice }, { name: awayTeam, price: awayPrice }] },
          { key: "totals", outcomes: [{ name: "Over", price: -110, point: total }, { name: "Under", price: -110, point: total }] },
        ],
      },
    ],
  };
}

// A loader that records every call (sport, and whether/what day was passed).
function recordingLoader(rows: Record<string, OddsGame[]>) {
  const calls: { sportKey: string; argCount: number; pastFetchDate?: string }[] = [];
  const load: OddsLoader = async (...args: [string, string?]) => {
    const [sportKey, pastFetchDate] = args;
    calls.push({ sportKey, argCount: args.length, ...(args.length > 1 ? { pastFetchDate } : {}) });
    return rows[args.length > 1 ? `${sportKey}|${pastFetchDate}` : `${sportKey}|today`] ?? [];
  };
  return { load, calls };
}

const HOUR = 3600_000;
const now = Date.now();
const todayEt = easternDateKey(new Date(now));
// 02:00Z the previous UTC day = 9 or 10 pm ET two UTC dates back: always an ET
// day strictly before today's, whatever time this runs.
const utcYesterday = new Date(now - 24 * HOUR);
const lateTip = new Date(Date.UTC(utcYesterday.getUTCFullYear(), utcYesterday.getUTCMonth(), utcYesterday.getUTCDate(), 2, 0, 0)).toISOString();
const lateDay = easternDateKey(new Date(lateTip));
// A game that started a minute ago: on today's ET day (unless this runs within
// a minute of ET midnight, which the guard below reports instead of failing).
const todayTip = new Date(now - 60_000).toISOString();
const todayTipIsToday = easternDateKey(new Date(todayTip)) === todayEt;

async function main() {
  expect("fixture: the late tip's ET day is before today's", lateDay < todayEt, true);

  // --- 1. late-night game: its own day's row
  {
    const NBA = "basketball_nba";
    const lateGame = oddsGame(NBA, "late", "Portland Trail Blazers", "Oklahoma City Thunder", lateTip, 110, -130, 228.5);
    // Today's row has a same-teams game (next game of a series) with the
    // favorite flipped - it must never be what the late game is ledgered from.
    const rematch = oddsGame(NBA, "rematch", "Portland Trail Blazers", "Oklahoma City Thunder", todayTip, -150, 130, 221.5);
    const { load, calls } = recordingLoader({ [`${NBA}|${lateDay}`]: [lateGame], [`${NBA}|today`]: [rematch] });
    const ledger = await ledgerFieldsForFinal(load, NBA, {
      homeTeam: "Portland Trail Blazers",
      awayTeam: "Oklahoma City Thunder",
      commenceTime: lateTip,
    });
    expect("late-night game: favTeam from its game day's row (away fav at -130)", ledger.favTeam, "Oklahoma City Thunder");
    expect("late-night game: totalLine from its game day's row", ledger.totalLine, 228.5);
    expect("late-night game: loader asked for the game's own ET day only", calls, [{ sportKey: NBA, argCount: 2, pastFetchDate: lateDay }]);

    // The old behaviour, for contrast: today's row alone has nothing on the
    // late game's day, so the fields were null.
    expect(
      "late-night game against today's row (old read): null",
      deriveLedgerFields([rematch], NBA, "Portland Trail Blazers", "Oklahoma City Thunder", new Date(lateTip)),
      { favTeam: null, totalLine: null }
    );

    // Missing past-day row (getPastDayOddsForSport returns []): null, and no
    // fallback to today's row.
    const missing = recordingLoader({ [`${NBA}|today`]: [rematch] });
    const none = await ledgerFieldsForFinal(missing.load, NBA, {
      homeTeam: "Portland Trail Blazers",
      awayTeam: "Oklahoma City Thunder",
      commenceTime: lateTip,
    });
    expect("late-night game, no row for its day: null, today's row never read", [none, missing.calls.length, missing.calls[0]?.argCount], [
      { favTeam: null, totalLine: null },
      1,
      2,
    ]);
  }

  // --- 2. same-day game: today's row, called exactly as before
  if (!todayTipIsToday) {
    console.log("SKIP: same-day case - this run is within a minute of ET midnight");
  } else {
    const NHL = "icehockey_nhl";
    const game = oddsGame(NHL, "today", "Boston Bruins", "Toronto Maple Leafs", todayTip, -140, 120, 6.5);
    const { load, calls } = recordingLoader({ [`${NHL}|today`]: [game] });
    const ledger = await ledgerFieldsForFinal(load, NHL, {
      homeTeam: "Boston Bruins",
      awayTeam: "Toronto Maple Leafs",
      commenceTime: todayTip,
    });
    expect("same-day game: favTeam / totalLine from today's row", ledger, { favTeam: "Boston Bruins", totalLine: 6.5 });
    expect("same-day game: loader called with the sport key alone (today's path, unchanged)", calls, [{ sportKey: NHL, argCount: 1 }]);
  }

  // --- 3. alias rows need the sport key
  {
    const ref = new Date(todayTip);
    const cases: { sport: string; feedHome: string; feedAway: string; oddsHome: string; oddsAway: string }[] = [
      // NCAAB: score feed "American University Eagles" = Odds API "American Eagles".
      { sport: "basketball_ncaab", feedHome: "American University Eagles", feedAway: "Army Black Knights", oddsHome: "American Eagles", oddsAway: "Army Knights" },
      // NCAAF: "Sam Houston Bearkats" = "Sam Houston State Bearkats", "App State" = "Appalachian State".
      { sport: "americanfootball_ncaaf", feedHome: "Sam Houston Bearkats", feedAway: "App State Mountaineers", oddsHome: "Sam Houston State Bearkats", oddsAway: "Appalachian State Mountaineers" },
      // NBA: ESPN "LA Clippers" = Odds API "Los Angeles Clippers".
      { sport: "basketball_nba", feedHome: "LA Clippers", feedAway: "Denver Nuggets", oddsHome: "Los Angeles Clippers", oddsAway: "Denver Nuggets" },
    ];
    for (const c of cases) {
      const og = oddsGame(c.sport, `alias-${c.sport}`, c.oddsHome, c.oddsAway, todayTip, -200, 170, 140.5);
      expect(
        `${c.sport}: "${c.feedHome}" matches "${c.oddsHome}" with the sport key; favTeam in the score feed's spelling`,
        deriveLedgerFields([og], c.sport, c.feedHome, c.feedAway, ref),
        { favTeam: c.feedHome, totalLine: 140.5 }
      );
      // The old call (no sport key): normalisation alone cannot bridge these.
      expect(
        `${c.sport}: same lookup without the sport key (old call) finds nothing`,
        deriveLedgerFields([og], "", c.feedHome, c.feedAway, ref),
        { favTeam: null, totalLine: null }
      );
    }
    // And through ledgerFieldsForFinal on a late-night NCAAB game (both fixes at once).
    const NCAAB = "basketball_ncaab";
    const og = oddsGame(NCAAB, "ncaab-late", "Boston Univ. Terriers", "Army Knights", lateTip, 150, -175, 131.5);
    const { load, calls } = recordingLoader({ [`${NCAAB}|${lateDay}`]: [og] });
    expect(
      "NCAAB late-night alias game: its day's row + alias match",
      [await ledgerFieldsForFinal(load, NCAAB, { homeTeam: "Boston University Terriers", awayTeam: "Army Black Knights", commenceTime: lateTip }), calls[0]?.pastFetchDate],
      [{ favTeam: "Army Black Knights", totalLine: 131.5 }, lateDay]
    );
  }

  // --- 4. one read per (sport, day) per run
  {
    const NBA = "basketball_nba";
    let loads = 0;
    const counted: OddsLoader = async (sportKey, pastFetchDate) => {
      loads++;
      void sportKey;
      void pastFetchDate;
      return [];
    };
    const loader = createRequestOddsLoader(counted);
    const finals = [
      { homeTeam: "A", awayTeam: "B", commenceTime: lateTip },
      { homeTeam: "C", awayTeam: "D", commenceTime: new Date(Date.parse(lateTip) + HOUR).toISOString() },
      { homeTeam: "E", awayTeam: "F", commenceTime: todayTip },
      { homeTeam: "G", awayTeam: "H", commenceTime: todayTip },
    ];
    const distinctRows = new Set(finals.map((g) => pastSnapshotDateFor(g.commenceTime) ?? "today")).size;
    await Promise.all(finals.map((g) => ledgerFieldsForFinal(loader, NBA, g)));
    expect("fixture: 4 finals span 2 snapshot rows", distinctRows, 2);
    expect("4 finals over 2 snapshot rows: one read per row", loads, distinctRows);
  }

  // --- 5. structural: the gate and the write are unchanged
  {
    const src = readFileSync(join(process.cwd(), "src/server/data/grading.ts"), "utf8");
    const persist = src.slice(src.indexOf("export async function persistFinalScores("));
    expect("gate unchanged: needsLedgerFields = !existing || existing.favTeam === null", /const needsLedgerFields = !existing \|\| existing\.favTeam === null;/.test(persist), true);
    expect("prefetch uses the same gate", /return !ex \|\| ex\.favTeam === null;/.test(persist), true);
    expect("ledger fields written only when there is data", /\.\.\.\(ledgerHasData\s*\n?\s*\? \{ favTeam: ledger!\.favTeam, totalLine: ledger!\.totalLine, lineSource: "odds_snapshot" \}/.test(persist), true);
    expect("one request loader per run", (persist.match(/createRequestOddsLoader\(\)/g) ?? []).length, 1);
    expect("no direct getOddsForSport read left in persistFinalScores", /getOddsForSport\(/.test(persist.slice(0, persist.indexOf("\n}\n"))), false);
  }

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nAll passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
