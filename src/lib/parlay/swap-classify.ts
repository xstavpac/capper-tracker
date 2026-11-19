// The Swap modal's tabs for one same-game candidate (generator.ts legSwapOptions):
// which of Primary / Hedge / Contrarian it belongs in, measured against the leg it
// would replace. Pure and client-safe. Read by the Swap modal only: parlay
// generation, Hedge / Contrarian as built (buildSwap) and the same-game rules are
// not changed by anything here.
//
//   CONTRARIAN  exactly contrarianMatch (contrarian-match.ts): the same bet, the
//               other side, within its tolerances. Checked first.
//   PRIMARY     the same side in the same market: the classifier's R1 when both are
//               the same bet type (an alternate line), or the same bet at the same
//               line from another capper (EXACT_DUPLICATE). Props: the same player,
//               stat, period and direction. R1 across markets (the same team's ML for
//               a spread leg, its spread for an ML leg) is HEDGE: another market on
//               the same game. R1 is left out of generation so a parlay doesn't stack
//               correlated legs; a swap REPLACES the leg, so that reason doesn't
//               apply here.
//   HEDGE /     every other same-game pick that is not PRIMARY. By team identity first:
//   CONTRARIAN  when the leg's team and the candidate's are both read from their text,
//               the same team (any market or scope) is HEDGE and the opposing team
//               CONTRARIAN, favorite / underdog never consulted. Only when either team
//               can't be read (a prop naming no team, a game total) is it by the
//               candidate's own status (FavDogInfo, the category behind "Favorite
//               moneyline" / "Underdog spread"; a prop by its team's): favorite HEDGE,
//               underdog CONTRARIAN. A game total, or a status that can't be read, is
//               HEDGE. Only the candidate's status is ever read, never the leg's.
//               The literal inverse (contrarianMatch above) is Contrarian first.
//   null        anything else on the game: the other side past contrarian's
//               tolerance (R2 / R3 in one market), R6, an unresolved team target,
//               or a description that can't be read (a prop with no readable player,
//               two props that may or may not be one player). Never guessed.
//
// Props are INACTIVE in describePick / classifyPair, and stay so: this reads them
// with describeProp, as contrarian-match.ts and same-game-rules.ts already do.
import { classifyPair, describePick, describeProp, samePropPlayer, type ParlayCandidate } from "@/lib/parlay/relationship-classifier";
import { contrarianMatch } from "@/lib/parlay/contrarian-match";
import { propTeam } from "@/lib/parlay/same-game-rules";
import { derivePickSide } from "@/lib/pick-side";

export type SameGameTab = "PRIMARY" | "HEDGE" | "CONTRARIAN";

export type FavDog = "FAVORITE" | "UNDERDOG";
// What the caller knows about a candidate's favorite / underdog status: `own` from the
// pick's category (the field behind "Favorite moneyline" / "Underdog spread"), and the
// game's two teams' status (from its full-game ML / spread picks) for a pick with no
// status of its own, a prop. null = unknown.
export type FavDogInfo = { own: FavDog | null; home: FavDog | null; away: FavDog | null };

export function categoryFavDog(category: string | null | undefined): FavDog | null {
  if (category === "FAV_ML" || category === "SPREAD_MINUS") return "FAVORITE";
  if (category === "DOG_ML" || category === "SPREAD_PLUS") return "UNDERDOG";
  return null;
}

type StatusPick = { betType: string; rawBetDetail: string | null; category?: string | null; homeTeam: string; awayTeam: string; leagueName: string };

// The game's teams' status from its full-game ML / spread picks (each one says which team
// is favored). A team the picks contradict each other on, or none speaks to, is null.
export function teamFavDog(picks: readonly StatusPick[]): { home: FavDog | null; away: FavDog | null } {
  const votes = { HOME: new Set<FavDog>(), AWAY: new Set<FavDog>() };
  for (const p of picks) {
    const fd = categoryFavDog(p.category);
    if (!fd) continue;
    const side = derivePickSide({ betType: p.betType, betDetail: p.rawBetDetail }, p, p.leagueName);
    if (!side) continue;
    votes[side].add(fd);
    votes[side === "HOME" ? "AWAY" : "HOME"].add(fd === "FAVORITE" ? "UNDERDOG" : "FAVORITE");
  }
  const one = (v: Set<FavDog>): FavDog | null => (v.size === 1 ? Array.from(v)[0] : null);
  return { home: one(votes.HOME), away: one(votes.AWAY) };
}

// The team a pick is on, when its own text says: an ML / spread / team total / prop that
// names a team. A game total, NRFI or a prop that names none has none.
const TEAM_BET_TYPES: ReadonlySet<string> = new Set(["MONEYLINE", "SPREAD", "TEAM_TOTAL", "PLAYER_PROP"]);
function teamOf(c: ParlayCandidate): "HOME" | "AWAY" | null {
  return TEAM_BET_TYPES.has(c.pick.betType) ? propTeam(c) : null;
}

// A same-game pick that isn't Primary: Hedge or Contrarian.
//   1. By team identity first: the leg's team is known and so is the candidate's ->
//      the same team (any market or scope) is Hedge, the opposing team Contrarian.
//      Favorite / underdog is not consulted.
//   2. Otherwise (either team unknown) by the candidate's own favorite / underdog
//      status: favorite Hedge, underdog Contrarian.
//   3. A game total (no team) and an unreadable status are Hedge.
function hedgeOrContrarian(leg: ParlayCandidate, cand: ParlayCandidate, fav: FavDogInfo | undefined, note?: string): SwapClass {
  const legTeam = teamOf(leg);
  const candTeam = teamOf(cand);
  const contrarian = legTeam !== null && candTeam !== null ? candTeam !== legTeam : candFavDog(cand, fav) === "UNDERDOG";
  if (contrarian) return note ? { tab: "CONTRARIAN", note } : { tab: "CONTRARIAN" };
  return note ? { tab: "HEDGE", note } : { tab: "HEDGE" };
}

function candFavDog(cand: ParlayCandidate, fav: FavDogInfo | undefined): FavDog | null {
  const bt = cand.pick.betType;
  if (!fav || !(bt === "MONEYLINE" || bt === "SPREAD" || bt === "PLAYER_PROP")) return null;
  if (fav.own) return fav.own;
  const side = propTeam(cand);
  return side === "HOME" ? fav.home : side === "AWAY" ? fav.away : null;
}

export type SwapClass =
  | { tab: SameGameTab; note?: string }
  | { tab: null; why: "OPPOSITE_PAST_TOLERANCE" | "NESTED_OPPOSITE" | "UNCLASSIFIED" | "UNDERIVABLE" | "UNVERIFIED_PROP" };

const isProp = (c: ParlayCandidate) => c.pick.betType === "PLAYER_PROP";

// `leg` is the leg being swapped, `cand` a pick on its game.
export function classifySwapCandidate(leg: ParlayCandidate, cand: ParlayCandidate, fav?: FavDogInfo): SwapClass {
  if (contrarianMatch(leg, cand).match) return { tab: "CONTRARIAN" };

  const legProp = isProp(leg);
  const candProp = isProp(cand);
  // A prop against a game market: the same game, another market.
  if (legProp !== candProp) return hedgeOrContrarian(leg, cand, fav);
  if (legProp && candProp) return propVsProp(leg, cand, fav);

  const o = classifyPair(leg, cand);
  if (o.outcome === "EXACT_DUPLICATE") return { tab: "PRIMARY" };
  if (o.outcome !== "RULE") return { tab: null, why: o.outcome === "UNDERIVABLE" ? "UNDERIVABLE" : "UNCLASSIFIED" };
  switch (o.rule) {
    case "R1":
      // An alternate line in the same market is Primary. The same team's ML for a spread
      // leg, or its spread for an ML leg, is another market on the same game: Hedge.
      return leg.pick.betType === cand.pick.betType ? { tab: "PRIMARY" } : { tab: "HEDGE" };
    case "R4":
    case "R5":
      return hedgeOrContrarian(leg, cand, fav);
    case "R2":
      // The other team, the same scope. In another side market it can win alongside
      // the leg (a dog's spread and the favorite's ML); in the same market it is the
      // other side, and contrarianMatch above already said it's past the tolerance.
      if (leg.pick.betType !== cand.pick.betType) return hedgeOrContrarian(leg, cand, fav, bothWinNote(leg, cand));
      return oppositePastTolerance(leg, cand, fav);
    case "R3":
      return oppositePastTolerance(leg, cand, fav);
    case "R6":
      return { tab: null, why: "NESTED_OPPOSITE" };
  }
}

// The other side of the same market past contrarian's tolerance: placed by the candidate's
// status when that is known, otherwise left unplaced as before.
function oppositePastTolerance(leg: ParlayCandidate, cand: ParlayCandidate, fav: FavDogInfo | undefined): SwapClass {
  const known = (teamOf(leg) !== null && teamOf(cand) !== null) || candFavDog(cand, fav) !== null;
  return known ? hedgeOrContrarian(leg, cand, fav) : { tab: null, why: "OPPOSITE_PAST_TOLERANCE" };
}

function propVsProp(leg: ParlayCandidate, cand: ParlayCandidate, fav: FavDogInfo | undefined): SwapClass {
  const sport = leg.game.sportName;
  const a = describeProp(leg.pick, sport);
  const b = describeProp(cand.pick, sport);
  if (a.status !== "OK" || b.status !== "OK") return { tab: null, why: "UNVERIFIED_PROP" };
  // Another stat, or another period: another market whoever it's on.
  if (a.market !== b.market || leg.pick.period !== cand.pick.period) return hedgeOrContrarian(leg, cand, fav);
  if (!samePropPlayer(a, b)) return hedgeOrContrarian(leg, cand, fav);
  // The names overlap ("Williams" / "Jalen Williams"). Both teams known and different:
  // two players. The same full name, or one inside the other on the same team: one player.
  const teamA = propTeam(leg);
  const teamB = propTeam(cand);
  if (teamA !== null && teamB !== null && teamA !== teamB) return hedgeOrContrarian(leg, cand, fav);
  const samePlayer = a.player === b.player || (teamA !== null && teamA === teamB);
  if (!samePlayer) return { tab: null, why: "UNVERIFIED_PROP" };
  // Same player and stat: the same direction is an alternate line; the other
  // direction past contrarian's tolerance (or a yes/no market) is neither.
  return a.direction === b.direction ? { tab: "PRIMARY" } : { tab: null, why: "OPPOSITE_PAST_TOLERANCE" };
}

// A dog's spread and the other team's ML, full game: both hit when the favorite
// wins by 1 up to the last margin the dog still covers (+5.5 -> 1-5, +5 -> 1-4, a
// push at 5). Nothing when the spread side is laying points, the line is unknown, or
// the window is empty.
function bothWinNote(leg: ParlayCandidate, cand: ParlayCandidate): string | undefined {
  if (leg.pick.period !== "FULL_GAME" || cand.pick.period !== "FULL_GAME") return undefined;
  const types = new Set([leg.pick.betType, cand.pick.betType]);
  if (!(types.has("SPREAD") && types.has("MONEYLINE"))) return undefined;
  const spread = leg.pick.betType === "SPREAD" ? leg : cand;
  const ml = spread === leg ? cand : leg;
  const ds = describePick(spread.pick, spread.game);
  const dm = describePick(ml.pick, ml.game);
  if (ds.status !== "OK" || dm.status !== "OK" || ds.line === null || !dm.direction || dm.direction === ds.direction) return undefined;
  if (!(ds.line > 0)) return undefined;
  const top = Math.ceil(ds.line) - 1;
  if (top < 1) return undefined;
  return `Can win with your pick: both hit if ${dm.direction} wins by ${top === 1 ? "1" : `1–${top}`}`;
}
