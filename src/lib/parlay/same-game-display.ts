// How a generated parlay with same-game legs is laid out and described on
// /parlay: the leg order, the "SGP" count, the header readout, and which
// same-game groups a "Send to FanDuel" answer left incomplete. Pure and
// client-safe (type-only imports), so it is tested without rendering.
import type { AutoLeg, SameGameLeg } from "@/lib/parlay/auto-generate";

export type DisplayLeg =
  | { kind: "TOP"; gameId: string; leg: AutoLeg; sameGame: boolean }
  | { kind: "SAME_GAME"; gameId: string; leg: SameGameLeg; sameGame: true };

// Parlay A's legs in their own order, each followed directly by the same-game
// legs added on its game (strongest first). `sameGame` marks every leg of a
// game that has two or more.
export function orderDisplayLegs(top: AutoLeg[], added: SameGameLeg[]): DisplayLeg[] {
  const out: DisplayLeg[] = [];
  for (const leg of top) {
    const extras = added.filter((a) => a.gameId === leg.gameId);
    out.push({ kind: "TOP", gameId: leg.gameId, leg, sameGame: extras.length > 0 });
    for (const extra of extras) out.push({ kind: "SAME_GAME", gameId: extra.gameId, leg: extra, sameGame: true });
  }
  return out;
}

// One SGP = one game with two or more legs. A game with three legs is one SGP.
export function sameGameCounts(legs: { gameId: string }[]): { legs: number; games: number; sgps: number } {
  const perGame = new Map<string, number>();
  for (const l of legs) perGame.set(l.gameId, (perGame.get(l.gameId) ?? 0) + 1);
  return { legs: legs.length, games: perGame.size, sgps: Array.from(perGame.values()).filter((n) => n > 1).length };
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

// "18 legs · 14 games · 2 SGPs". With no SGP the readout is today's:
// "14 legs · MLB, NFL".
export function legCountText(legs: { gameId: string }[], leagues: string[]): string {
  const c = sameGameCounts(legs);
  if (c.sgps === 0) return count(c.legs, "leg") + " · " + leagues.join(", ");
  return [count(c.legs, "leg"), count(c.games, "game"), count(c.sgps, "SGP")].join(" · ");
}

export type IncompleteSameGameGroup = { gameId: string; gameLabel: string; sent: number; total: number };

// The same-game groups (two or more legs on one game) that a FanDuel answer
// did not carry whole: at least one of the group's legs is not in the link.
// A leg with no gameId is in no group.
export function incompleteSameGameGroups(
  legs: { pickId: string; gameId?: string; gameLabel?: string }[],
  sentPickIds: ReadonlySet<string>
): IncompleteSameGameGroup[] {
  const groups = new Map<string, IncompleteSameGameGroup>();
  for (const leg of legs) {
    if (!leg.gameId) continue;
    const g = groups.get(leg.gameId) ?? { gameId: leg.gameId, gameLabel: leg.gameLabel ?? "", sent: 0, total: 0 };
    g.total++;
    if (sentPickIds.has(leg.pickId)) g.sent++;
    groups.set(leg.gameId, g);
  }
  return Array.from(groups.values()).filter((g) => g.total > 1 && g.sent < g.total);
}
