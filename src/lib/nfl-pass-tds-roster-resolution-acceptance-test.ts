// Passing-TDs player resolution during catalog-import recovery: QB-only candidates, starter/slate
// tie-break, specific (never generic) failure reasons. Pure - fixture rosters, no network or database.
// Run with: npx tsx src/lib/nfl-pass-tds-roster-resolution-acceptance-test.ts
import { recoverUnresolvedLines } from "@/lib/recover-unresolved-lines";
import type { RosterPlayer } from "@/server/data/nfl-roster";
import type { LiveTeam } from "@/lib/live-team-fallback";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} - expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  if (!pass) failures++;
}

let nextId = 1;
function rp(playerName: string, team: string, position: string): RosterPlayer {
  const [firstName, ...rest] = playerName.split(" ");
  return { playerName, firstName, lastName: rest.join(" "), team, position, externalPlayerId: String(nextId++) };
}
const ROSTER: RosterPlayer[] = [
  rp("Deshaun Watson", "Cleveland Browns", "QB"),
  rp("Christian Watson", "Green Bay Packers", "WR"),
  rp("Daniel Jones", "Indianapolis Colts", "QB"),
  rp("Mac Jones", "San Francisco 49ers", "QB"),
  rp("Josh Allen", "Buffalo Bills", "QB"),
  rp("Josh Allen", "Jacksonville Jaguars", "WR"), // same full name, different position
  rp("Russell Wilson", "New York Giants", "QB"),
  rp("Jalen Hurts", "Philadelphia Eagles", "QB"),
  rp("Jalen Hurts", "Chicago Bears", "QB"), // pathological: same full name, two QBs
  rp("Patrick Mahomes", "Kansas City Chiefs", "QB"),
  rp("Travis Kelce", "Kansas City Chiefs", "TE"),
];
const slate = (...teams: string[]): LiveTeam[] => teams.map((name) => ({ sport: "NFL", name }));

// A slate with NFL teams on it is treated as complete (both feeds answered) unless a case says otherwise.
function run(line: string, live: LiveTeam[] = [], complete = live.some((t) => t.sport === "NFL")) {
  return recoverUnresolvedLines([line], ["Capper"], live, ROSTER, [], [], [], complete ? ["NFL"] : []);
}
const offered = (r: ReturnType<typeof run>) => r.recovered.map((p) => p.ambiguous?.map((o) => o.label));
function resolvedTo(line: string, live: LiveTeam[] = []) {
  const r = run(line, live);
  return r.recovered.length === 1 ? { team: r.recovered[0].teamNicknames[0], sport: r.recovered[0].sportName, desc: r.recovered[0].description } : { still: r.stillUnresolved, reason: r.reasons[line] };
}

// ---- QB-only: "Watson" is Deshaun (QB), never Christian (WR) ----
check("bare 'Watson' resolves to Deshaun Watson's team (QB), not Christian Watson's", resolvedTo("Watson over 0.5 passing TDs"), {
  team: "cleveland browns",
  sport: "NFL",
  desc: "Watson over 0.5 passing TDs",
});
check("full name resolves", (resolvedTo("Deshaun watson over 0.5 passing touchdowns") as any).team, "cleveland browns");
check("N+ form resolves and is stored normalized", resolvedTo("Watson 1+ passing TD"), {
  team: "cleveland browns",
  sport: "NFL",
  desc: "Watson Over 0.5 passing TD",
});
check("same full name at two positions -> the QB", (resolvedTo("Josh Allen over 1.5 passing TDs") as any).team, "buffalo bills");

// ---- non-QB: specific reason naming the player and position ----
{
  const r = run("Christian Watson over 0.5 passing TDs");
  check("WR is rejected, not recovered", [r.recovered.length, r.stillUnresolved], [0, ["Christian Watson over 0.5 passing TDs"]]);
  check(
    "WR reason names the player, team and position",
    r.reasons["Christian Watson over 0.5 passing TDs"],
    "Christian Watson (Green Bay Packers) is a WR, not a quarterback - passing TDs is a QB-only market"
  );
}
{
  const r = run("Kelce o0.5 pass TD");
  check("TE surname -> specific non-QB reason", r.reasons["Kelce o0.5 pass TD"], "Travis Kelce (Kansas City Chiefs) is a TE, not a quarterback - passing TDs is a QB-only market");
}

// ---- unknown name ----
{
  const r = run("Zxqv Nobody over 0.5 passing TDs");
  check("unknown name -> specific reason", r.reasons["Zxqv Nobody over 0.5 passing TDs"], 'couldn\'t find a quarterback named "Zxqv Nobody" on an active NFL roster');
}

// ---- two QBs sharing a surname ----
{
  const line = "Jones over 1.5 passing TDs";
  const bothJones = [["Daniel Jones — Colts QB", "Mac Jones — 49ers QB"]];
  const none = run(line);
  check("no slate info: asks which quarterback, offering both (never guessed)", offered(none), bothJones);
  check("...and is not left as an unresolved line", [none.stillUnresolved, none.reasons[line]], [[], undefined]);
  check("only one of the two has a game this window -> that one", (resolvedTo(line, slate("Indianapolis Colts", "Tennessee Titans")) as any).team, "indianapolis colts");
  check("the other one has the game -> the other one", (resolvedTo(line, slate("San Francisco 49ers", "Seattle Seahawks")) as any).team, "san francisco 49ers");
  check("both play this window -> asks which quarterback", offered(run(line, slate("Indianapolis Colts", "San Francisco 49ers"))), bothJones);
  check("a slate not known to be complete never breaks the tie", offered(run(line, slate("Indianapolis Colts", "Tennessee Titans"), false)), bothJones);
  // Paste context ("Colts ..." named elsewhere in the paste) does NOT break the tie.
  const withPaste = recoverUnresolvedLines([line], ["Capper"], [], ROSTER, [
    { capperName: "Capper", sportName: "NFL", description: "Colts -3", betType: "SPREAD", odds: -110, hasExplicitOdds: false, totalSide: null, units: 1, period: "FULL_GAME", raw: "Colts -3", teamNicknames: ["colts"], gameNumber: null } as any,
  ]);
  check("a paste mention of the Colts does not pick Daniel Jones", offered(withPaste), bothJones);
  check("full first name needs no tie-break", (resolvedTo("Mac Jones over 1.5 passing TDs") as any).team, "san francisco 49ers");
}
{
  const r = run("Hurts over 0.5 passing TDs");
  check("two QBs sharing a surname AND a first name, bare surname -> asks which (never guessed)", offered(r), [["Jalen Hurts — Eagles QB", "Jalen Hurts — Bears QB"]]);
  const full = run("Jalen Hurts over 0.5 passing TDs");
  check("the same two typed in full -> not recovered, reason lists both", [full.recovered.length, /more than one quarterback/.test(full.reasons["Jalen Hurts over 0.5 passing TDs"] ?? "")], [0, true]);
}

// ---- no game in the window ----
{
  const line = "Deshaun Watson over 0.5 passing TDs";
  const r = run(line, slate("Buffalo Bills", "Miami Dolphins"));
  check("QB's team not on the live NFL slate -> specific no-game reason", [r.recovered.length, r.reasons[line]], [
    0,
    "Deshaun Watson (Cleveland Browns) has no game in the current NFL window (bye week or not scheduled), so this pick can't be matched to a game",
  ]);
  check("non-NFL teams on the board don't count as the NFL slate", (resolvedTo(line, [{ sport: "NBA", name: "Cleveland Cavaliers" }] as LiveTeam[]) as any).team, "cleveland browns");
  check("QB's team on the slate -> recovered", (resolvedTo(line, slate("Cleveland Browns", "Carolina Panthers")) as any).team, "cleveland browns");
}

// ---- other markets are untouched: no reasons, same behavior ----
{
  const line = "Mahomes over 250.5 passing yards";
  const r = run(line);
  check("passing-yards path unchanged (resolves via the generic resolver)", [r.recovered.length, Object.keys(r.reasons).length], [1, 0]);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
