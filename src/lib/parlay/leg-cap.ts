// The one leg ceiling for every Parlay Generator mode - Auto-Generate, My
// Picks, Auto Hedge and Contrarian. Client-safe: nothing here imports
// server/data or prisma, so the /parlay client components, the Parlay Pool
// context and the server actions can all share it.
//
// Enforced in three places, none of which trims: the leg stepper
// (parlay-controls.tsx), the slip's confirmAdd (parlay-pool-context.tsx), and
// the server actions (parlay-generator.ts, parlay-pool-generator.ts). A
// request past the cap is refused with MAX_PARLAY_LEGS_MESSAGE.
export const MAX_PARLAY_LEGS = 25;

// The most legs a parlay takes from one game ("Max legs per game"). Bounds the
// generated legs only - a slip pick is never dropped to meet it.
export const MAX_LEGS_PER_GAME = 5;

export const MAX_PARLAY_LEGS_MESSAGE = `${MAX_PARLAY_LEGS} legs max`;

// The most slip picks one Auto Hedge / Contrarian request may name. Above the
// leg cap on purpose - a slip saved before the cap existed can hold more than
// MAX_PARLAY_LEGS picks and still builds from all of them - but bounded, so
// the request's size is never the client's to choose.
export const MAX_POOL_REQUEST_PICKS = 100;

// What a server action returns instead of its result when it refuses the
// request. Returned, not thrown: a production build strips a thrown error's
// message before it reaches the client, and this one has to be shown.
export type ParlayRejection = { error: string };
export type LegCapRejection = ParlayRejection;

export function legCapRejection(legCount: number): LegCapRejection | null {
  return Math.floor(legCount) > MAX_PARLAY_LEGS ? { error: MAX_PARLAY_LEGS_MESSAGE } : null;
}
