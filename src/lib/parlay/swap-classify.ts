// The Swap modal's tabs for one same-game candidate (generator.ts legSwapOptions):
// which of Primary / Hedge / Contrarian it belongs in, measured against the leg it
// would replace. Pure and client-safe. Read by the Swap modal only: parlay
// generation, Hedge / Contrarian as built (buildSwap) and the same-game rules are
// not changed by anything here.
//
//   CONTRARIAN  exactly contrarianMatch (contrarian-match.ts): the same bet, the
//               other side, within its tolerances. Checked first.
//   PRIMARY     the same side in the same market family: the classifier's R1 (an
//               alternate line, or the same team's ML for a spread and its spread
//               for an ML), or the same bet at the same line from another capper
//               (EXACT_DUPLICATE). Props: the same player, stat, period and
//               direction. R1 is left out of generation so a parlay doesn't stack
//               correlated legs; a swap REPLACES the leg, so that reason doesn't
//               apply here.
//   HEDGE       the same game, a different market: R4 (side vs total) and R5
//               (nested scope, same direction), the other team in another side
//               market (R2 across betTypes: W&M +5.5 -> FAU ML), and any same-game
//               player prop that isn't one of the above (another player or stat, or
//               a prop against a game market).
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

export type SameGameTab = "PRIMARY" | "HEDGE" | "CONTRARIAN";

export type SwapClass =
  | { tab: SameGameTab; note?: string }
  | { tab: null; why: "OPPOSITE_PAST_TOLERANCE" | "NESTED_OPPOSITE" | "UNCLASSIFIED" | "UNDERIVABLE" | "UNVERIFIED_PROP" };

const isProp = (c: ParlayCandidate) => c.pick.betType === "PLAYER_PROP";

// `leg` is the leg being swapped, `cand` a pick on its game.
export function classifySwapCandidate(leg: ParlayCandidate, cand: ParlayCandidate): SwapClass {
  if (contrarianMatch(leg, cand).match) return { tab: "CONTRARIAN" };

  const legProp = isProp(leg);
  const candProp = isProp(cand);
  // A prop against a game market: the same game, another market.
  if (legProp !== candProp) return { tab: "HEDGE" };
  if (legProp && candProp) return propVsProp(leg, cand);

  const o = classifyPair(leg, cand);
  if (o.outcome === "EXACT_DUPLICATE") return { tab: "PRIMARY" };
  if (o.outcome !== "RULE") return { tab: null, why: o.outcome === "UNDERIVABLE" ? "UNDERIVABLE" : "UNCLASSIFIED" };
  switch (o.rule) {
    case "R1":
      return { tab: "PRIMARY" };
    case "R4":
    case "R5":
      return { tab: "HEDGE" };
    case "R2":
      // The other team, the same scope. In another side market it can win alongside
      // the leg (a dog's spread and the favorite's ML); in the same market it is the
      // other side, and contrarianMatch above already said it's past the tolerance.
      if (leg.pick.betType !== cand.pick.betType) {
        const note = bothWinNote(leg, cand);
        return note ? { tab: "HEDGE", note } : { tab: "HEDGE" };
      }
      return { tab: null, why: "OPPOSITE_PAST_TOLERANCE" };
    case "R3":
      return { tab: null, why: "OPPOSITE_PAST_TOLERANCE" };
    case "R6":
      return { tab: null, why: "NESTED_OPPOSITE" };
  }
}

function propVsProp(leg: ParlayCandidate, cand: ParlayCandidate): SwapClass {
  const sport = leg.game.sportName;
  const a = describeProp(leg.pick, sport);
  const b = describeProp(cand.pick, sport);
  if (a.status !== "OK" || b.status !== "OK") return { tab: null, why: "UNVERIFIED_PROP" };
  // Another stat, or another period: another market whoever it's on.
  if (a.market !== b.market || leg.pick.period !== cand.pick.period) return { tab: "HEDGE" };
  if (!samePropPlayer(a, b)) return { tab: "HEDGE" };
  // The names overlap ("Williams" / "Jalen Williams"). Both teams known and different:
  // two players. The same full name, or one inside the other on the same team: one player.
  const teamA = propTeam(leg);
  const teamB = propTeam(cand);
  if (teamA !== null && teamB !== null && teamA !== teamB) return { tab: "HEDGE" };
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
