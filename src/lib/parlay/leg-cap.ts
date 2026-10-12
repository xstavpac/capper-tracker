// The one leg ceiling for every Parlay Generator mode - Auto-Generate, My
// Picks, Auto Hedge and Contrarian. Client-safe: nothing here imports
// server/data or prisma, so the /parlay client components, the Parlay Pool
// context and the server actions can all share it.
//
// Enforced in three places, none of which trims: the leg stepper
// (parlay-controls.tsx), the slip's confirmAdd (parlay-pool-context.tsx), and
// the server actions (parlay-generator.ts, parlay-pool-generator.ts). A
// request past the cap is refused with MAX_PARLAY_LEGS_MESSAGE.
export const MAX_PARLAY_LEGS = 20;

export const MAX_PARLAY_LEGS_MESSAGE = `${MAX_PARLAY_LEGS} legs max`;

// What a server action returns instead of its result when the request is over
// the cap. Returned, not thrown: a production build strips a thrown error's
// message before it reaches the client, and this one has to be shown.
export type LegCapRejection = { error: string };

export function legCapRejection(legCount: number): LegCapRejection | null {
  return Math.floor(legCount) > MAX_PARLAY_LEGS ? { error: MAX_PARLAY_LEGS_MESSAGE } : null;
}
