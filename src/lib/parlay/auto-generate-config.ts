// Client-safe constants for Auto-Generate. Kept apart from auto-generate.ts,
// which imports rankCandidates (and through it server/data/picks + prisma),
// so the /parlay client component can import these without pulling any of
// that into the browser bundle.

// Stepper ceiling for Auto-Generate (My Picks is bounded by its pool size
// instead; Auto-Generate has no pool, so it gets a fixed cap).
export const AUTO_GENERATE_MAX_LEGS = 10;
