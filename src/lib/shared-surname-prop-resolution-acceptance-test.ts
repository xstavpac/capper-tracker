// Proof for shared-surname player-prop resolution at import - run with:
//   npx tsx src/lib/shared-surname-prop-resolution-acceptance-test.ts
//
// The bug (2026-10): "McCaffrey over 38.5 receiving yards" was imported as
// Luke McCaffrey (Commanders WR) and matched to Colts @ Commanders, because
// the paste named the Commanders elsewhere. Christian McCaffrey (49ers RB) is
// the other rostered McCaffrey. A bare surname 2+ rostered players share must
// never be guessed: it resolves on its own only when a COMPLETE slate has
// exactly one candidate's team on it, and otherwise asks the user.
//
// Pure - no network, no database, no auth. Runs the real pipeline end to end:
// parseCatalog -> recoverUnresolvedLines -> runAmbiguousHierarchy (with a fake
// schedule checker) -> resolveAmbiguousPick.
import { parseCatalog, resolveAmbiguousPick, isPlayerAmbiguityKey, type ParsedPick } from "@/lib/parse-catalog";
import { recoverUnresolvedLines } from "@/lib/recover-unresolved-lines";
import { runAmbiguousHierarchy, type ScheduleChecker } from "@/lib/ambiguous-hierarchy";
import type { RosterPlayer } from "@/server/data/nfl-roster";
import type { LiveTeam } from "@/lib/live-team-fallback";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

function rp(externalPlayerId: string, playerName: string, team: string, position: string): RosterPlayer {
  const [firstName, ...rest] = playerName.split(" ");
  return { externalPlayerId, playerName, firstName, lastName: rest.join(" "), team, position };
}
// Real ESPN ids/teams/positions for the two McCaffreys (2026-10-06).
const ROSTER: RosterPlayer[] = [
  rp("3117251", "Christian McCaffrey", "San Francisco 49ers", "RB"),
  rp("4426948", "Luke McCaffrey", "Washington Commanders", "WR"),
  rp("4685702", "Quinshon Judkins", "Cleveland Browns", "RB"),
  rp("9000001", "Daniel Jones", "Indianapolis Colts", "QB"),
  rp("9000002", "Mac Jones", "San Francisco 49ers", "QB"),
  rp("9000003", "Aaron Jones", "Minnesota Vikings", "RB"),
];

const slate = (...teams: string[]): LiveTeam[] => teams.map((name) => ({ sport: "NFL", name }));
const NINERS = "San Francisco 49ers";
const COMMANDERS = "Washington Commanders";
const BOTH_PLAYING = slate("Denver Broncos", NINERS, "Indianapolis Colts", COMMANDERS, "Cleveland Browns");
const ONLY_NINERS = slate("Denver Broncos", NINERS, "Indianapolis Colts", "Cleveland Browns"); // Commanders on a bye
const ONLY_COMMANDERS = slate("Indianapolis Colts", COMMANDERS, "Cleveland Browns"); // 49ers on a bye
const COMPLETE = ["NFL"];

const MCCAFFREY = "McCaffrey over 38.5 receiving yards";
const BOTH_LABELS = ["Christian McCaffrey — 49ers RB", "Luke McCaffrey — Commanders WR"];

function importPaste(paste: string, live: LiveTeam[], completeSports: string[]) {
  const parsed = parseCatalog(paste, ["Godfather", "Krash"], ROSTER.map((p) => p.playerName));
  const out = recoverUnresolvedLines(parsed.unresolved, parsed.unresolvedCapperNames, live, ROSTER, parsed.picks, [], [], completeSports);
  return { firstPass: parsed.picks, ...out };
}
// What the preview would show for one recovered pick: the team it resolved to, or the options it asks about.
const outcome = (p: ParsedPick | undefined) => (p ? (p.ambiguous ? { asks: p.ambiguous.map((o) => o.label) } : { team: p.teamNicknames[0] }) : "not recovered");
const mccaffrey = (r: ReturnType<typeof importPaste>) => outcome(r.recovered.find((p) => p.raw === MCCAFFREY));

// A schedule checker that says EVERY candidate has a game today - the strongest
// signal the team hierarchy has. It must not be able to settle a player key.
const everyonePlays: ScheduleChecker = async (queries) => Object.fromEntries(queries.map((q) => [q.nickname + "|" + q.sport, true]));
const deps = { runScheduleCheck: everyonePlays, runWideScheduleCheck: everyonePlays, now: new Date("2026-10-06T12:00:00Z") };

async function main() {
  console.log("\n########## 1: both teams playing -> prompt ##########");
  {
    const r = importPaste("Godfather\n" + MCCAFFREY, BOTH_PLAYING, COMPLETE);
    check("1a: asks which McCaffrey, with full name, team and position on each option", mccaffrey(r), { asks: BOTH_LABELS });
    check("1b: not left as an unresolved line", r.stillUnresolved, []);
    const pick = r.recovered[0];
    check("1c: no team attached before the answer", [pick.teamNicknames, pick.sportName, pick.capperName], [[], "NFL", "Godfather"]);
    check("1d: each option carries the player's own team", pick.ambiguous?.map((o) => [o.sport, o.nickname]), [
      ["NFL", "san francisco 49ers"],
      ["NFL", "washington commanders"],
    ]);
  }

  console.log("\n########## 2: only one candidate's team playing (complete slate) ##########");
  {
    check("2a: only the 49ers play -> Christian McCaffrey", mccaffrey(importPaste("Godfather\n" + MCCAFFREY, ONLY_NINERS, COMPLETE)), { team: "san francisco 49ers" });
    check("2b: only the Commanders play -> Luke McCaffrey", mccaffrey(importPaste("Godfather\n" + MCCAFFREY, ONLY_COMMANDERS, COMPLETE)), { team: "washington commanders" });
    check("2c: neither plays -> prompt", mccaffrey(importPaste("Godfather\n" + MCCAFFREY, slate("Cleveland Browns", "Denver Broncos"), COMPLETE)), { asks: BOTH_LABELS });
  }

  console.log("\n########## 3: the paste names the Commanders elsewhere -> still prompts ##########");
  {
    const paste = "Godfather\nCommanders -3\n" + MCCAFFREY;
    const r = importPaste(paste, BOTH_PLAYING, COMPLETE);
    check("3 sanity: the Commanders pick itself resolved on the first pass", r.firstPass.map((p) => p.teamNicknames), [["commanders"]]);
    check("3a: a team named in another pick does not choose the player (the reported bug)", mccaffrey(r), { asks: BOTH_LABELS });
    check("3b: same with no slate at all", mccaffrey(importPaste(paste, [], [])), { asks: BOTH_LABELS });
    check("3c: same when the mention comes after the prop", mccaffrey(importPaste("Godfather\n" + MCCAFFREY + "\nCommanders -3", BOTH_PLAYING, COMPLETE)), { asks: BOTH_LABELS });
    check("3d: a complete slate with only the 49ers on it still wins over the mention", mccaffrey(importPaste(paste, ONLY_NINERS, COMPLETE)), { team: "san francisco 49ers" });
  }

  console.log("\n########## 4: full name -> unchanged ##########");
  {
    const line = "Christian McCaffrey over 38.5 receiving yards";
    for (const [label, live, complete] of [
      ["both playing", BOTH_PLAYING, COMPLETE],
      ["no slate", [], []],
      ["complete slate without the 49ers", ONLY_COMMANDERS, COMPLETE],
      ["paste names the Commanders", BOTH_PLAYING, COMPLETE],
    ] as [string, LiveTeam[], string[]][]) {
      const paste = "Godfather\n" + (label.startsWith("paste") ? "Commanders -3\n" : "") + line;
      const r = importPaste(paste, live, complete);
      check("4: full name resolves to the 49ers, no prompt (" + label + ")", outcome(r.recovered.find((p) => p.raw === line)), { team: "san francisco 49ers" });
    }
    check("4b: the other full name resolves to the Commanders", outcome(importPaste("Godfather\nLuke McCaffrey over 2.5 receptions", BOTH_PLAYING, COMPLETE).recovered[0]), { team: "washington commanders" });
  }

  console.log("\n########## 5: unique surname -> unchanged ##########");
  {
    const line = "Judkins over 60.5 rushing yards";
    for (const [label, live, complete] of [
      ["both playing", BOTH_PLAYING, COMPLETE],
      ["no slate", [], []],
      ["slate not complete", BOTH_PLAYING, []],
      ["Browns absent from a complete slate (bye)", slate(NINERS, COMMANDERS), COMPLETE],
    ] as [string, LiveTeam[], string[]][]) {
      check("5: unique surname resolves to the Browns, no prompt (" + label + ")", outcome(importPaste("Godfather\n" + line, live, complete).recovered[0]), { team: "cleveland browns" });
    }
  }

  console.log("\n########## 6: slate lookup failure / partial slate -> prompt ##########");
  {
    check("6a: lookup failed, nothing came back -> prompt", mccaffrey(importPaste("Godfather\n" + MCCAFFREY, [], [])), { asks: BOTH_LABELS });
    check("6b: partial slate that happens to list only the 49ers -> prompt, not Christian", mccaffrey(importPaste("Godfather\n" + MCCAFFREY, ONLY_NINERS, [])), { asks: BOTH_LABELS });
    check("6c: partial slate that happens to list only the Commanders -> prompt, not Luke", mccaffrey(importPaste("Godfather\n" + MCCAFFREY, ONLY_COMMANDERS, [])), { asks: BOTH_LABELS });
    check("6d: another sport's slate being complete says nothing about the NFL", mccaffrey(importPaste("Godfather\n" + MCCAFFREY, ONLY_NINERS, ["NHL"])), { asks: BOTH_LABELS });
  }

  console.log("\n########## 7: one answer resolves identical picks with identical options ##########");
  {
    const r = importPaste("Godfather\n" + MCCAFFREY + "\nKrash\nmccaffrey over 4.5 receptions\nJones over 1.5 passing TDs\nJones over 3.5 receptions", BOTH_PLAYING, COMPLETE);
    const byRaw = (raw: string) => r.recovered.find((p) => p.raw === raw)!;
    const a = byRaw(MCCAFFREY);
    const b = byRaw("mccaffrey over 4.5 receptions");
    const qbJones = byRaw("Jones over 1.5 passing TDs");
    const anyJones = byRaw("Jones over 3.5 receptions");
    check("7a: two McCaffrey picks (different cappers, casing, market) share one question", a.ambiguousKey === b.ambiguousKey && isPlayerAmbiguityKey(a.ambiguousKey!), true);
    check("7b: passing TDs offers quarterbacks only", qbJones.ambiguous?.map((o) => o.label), ["Daniel Jones — Colts QB", "Mac Jones — 49ers QB"]);
    check("7c: the same surname in another market offers every Jones", anyJones.ambiguous?.map((o) => o.label), ["Daniel Jones — Colts QB", "Mac Jones — 49ers QB", "Aaron Jones — Vikings RB"]);
    check("7d: different options -> a different question", qbJones.ambiguousKey !== anyJones.ambiguousKey, true);
    check("7e: McCaffrey and Jones are different questions", a.ambiguousKey !== qbJones.ambiguousKey, true);

    // Nothing in the automatic hierarchy may answer for the user - not even
    // "every candidate has a game today".
    const auto = await runAmbiguousHierarchy([...r.recovered], {}, deps);
    check("7f: the automatic hierarchy leaves all four picks asking", auto.picks.filter((p) => p.ambiguous).length, 4);
    check("7g: ...as three questions (McCaffrey x2, QB Jones, any Jones)", auto.stillAmbiguous.map((g) => g.count).sort(), [1, 1, 2]);
    check("7h: ...and records no decision of its own", auto.decisions, {});

    // The user's click (resolveAmbiguousGroup in bulk-import-form.tsx): every pick sharing the key.
    const christian = a.ambiguous![0];
    const answered = r.recovered.map((p) => (p.ambiguousKey === a.ambiguousKey ? resolveAmbiguousPick(p, christian) : p));
    check(
      "7i: answering Christian resolves both McCaffrey picks to the 49ers",
      answered.filter((p) => /mccaffrey/i.test(p.raw)).map((p) => [p.capperName, p.sportName, p.betType, p.teamNicknames, p.ambiguous]),
      [
        ["Godfather", "NFL", "PLAYER_PROP", ["san francisco 49ers"], undefined],
        ["Krash", "NFL", "PLAYER_PROP", ["san francisco 49ers"], undefined],
      ]
    );
    check("7j: the Jones picks are untouched by that answer", answered.filter((p) => /jones/i.test(p.raw)).every((p) => Boolean(p.ambiguous)), true);
    check("7k: the pick text is kept as typed", answered.find((p) => p.raw === MCCAFFREY)?.description, MCCAFFREY);

    // Same-import memory: a re-parse of the same paste honours the earlier answer.
    const again = importPaste("Godfather\n" + MCCAFFREY, BOTH_PLAYING, COMPLETE);
    const remembered = await runAmbiguousHierarchy([...again.recovered], { [a.ambiguousKey!]: christian }, deps);
    check("7l: an answer given earlier in this import is reapplied on re-parse", remembered.picks.map((p) => [p.teamNicknames, p.ambiguous]), [[["san francisco 49ers"], undefined]]);
  }

  if (failures > 0) {
    console.log(`\n${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log("\nALL CHECKS PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
