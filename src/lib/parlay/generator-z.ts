// The generator's Wilson z: softer than the shared 1.96, so a mid-volume record
// sits close to a huge one (18-4 is 4.2 points under 100-30, 7.5 at 1.96) while
// a tiny perfect one stays well below it (3-0 is 9.6 points under 18-4). Much
// softer and 3-0 / 5-0 records float to the top (the replay at z=1.0: median
// leg sample 5, average leg 92%).
//
// Import-free, in its own module so pick-record.ts (recordForGate's best-of-two)
// can score with it without importing generator.ts, which imports pick-record.ts.
// generator.ts re-exports it.
export const GENERATOR_Z = 1.5;
