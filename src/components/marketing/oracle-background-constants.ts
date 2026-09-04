// Plain (non-"use client") module: every export from a "use client" module
// becomes an opaque client reference when imported into a Server Component
// (see energy-surge-constants.ts's header for the same gotcha), and the
// geometry helpers here are also imported by a plain `tsx` acceptance-test
// script, so this file must stay free of both "use client" and any
// React/next/font import.
//
// All values are lifted verbatim from the original 1280x720 HTML prototype of
// the "oracle" login background. The 5 capper picks and their WIN/LOSS
// outcomes are intentional fixed demo data - do not make them dynamic.

export type Outcome = "win" | "loss";

// ---- Canvas geometry (the prototype's fixed coordinate space) ----
export const CANVAS_W = 1280;
export const CANVAS_H = 720;
export const CUBE_X = 640; // center of the login slot, where wires converge
export const CUBE_Y = 360;
export const SLOT_HALF = 150; // half-width of the gap the wires leave for the slot
export const LEFT_X = 274; // right edge of the capper cards (24 + 250)
export const RIGHT_X = 1006; // left edge of the result cards (1280 - 24 - 250)

// Below this viewport width the wide diagram is not rendered at all - only the
// ambient glow behind the login card. A shrunk 10-card diagram would just be
// illegible clutter at phone widths.
export const MOBILE_BREAKPOINT = 768;

// ---- Sequencer timing (from runForever / firePick in the prototype) ----
export const IN_DUR = 1100; // capper -> slot leg
export const OUT_DUR = 1100; // slot -> result leg
export const CUBE_DUR = 500; // passthrough flash behind the slot
export const GAP_MIN = 350; // gap before the next pick fires...
export const GAP_RANGE = 550; // ...plus up to this much jitter
export const ROUND_PAUSE_MIN = 1200; // pause after all 5 fire, before reshuffling...
export const ROUND_PAUSE_RANGE = 800;

// ---- Card content (fixed demo data) ----
const CARD_TOPS = [130, 225, 320, 415, 510] as const;
const CARD_HEIGHT = 78;

export interface CapperCard {
  top: number;
  name: string;
  pick: string;
  matchup: string;
}

export interface ResultCard {
  top: number;
  emoji: string;
  score: string;
  sub: string;
  outcome: Outcome;
}

export const CAPPER_CARDS: CapperCard[] = [
  { top: CARD_TOPS[0], name: "@VegasLock", pick: "LAL -4.5", matchup: "vs BOS   10:15 AM" },
  { top: CARD_TOPS[1], name: "@SharpSide", pick: "BUF ML", matchup: "vs KC   11:02 AM" },
  { top: CARD_TOPS[2], name: "@ActionNick", pick: "NYR -1.5", matchup: "vs NJD   11:31 AM" },
  { top: CARD_TOPS[3], name: "@ParlayGod", pick: "ATL -2.5", matchup: "vs MIA   1:05 PM" },
  { top: CARD_TOPS[4], name: "@BankrollBilly", pick: "O/8.5", matchup: "MLB   3:12 PM" },
];

export const RESULT_CARDS: ResultCard[] = [
  { top: CARD_TOPS[0], emoji: "🏀", score: "LAL 112 – 106 BOS", sub: "Spread -4.5", outcome: "win" },
  { top: CARD_TOPS[1], emoji: "🏈", score: "KC 31 – 20 BUF", sub: "Moneyline", outcome: "loss" },
  { top: CARD_TOPS[2], emoji: "🏒", score: "NYR 4 – 1 NJD", sub: "Puck Line -1.5", outcome: "win" },
  { top: CARD_TOPS[3], emoji: "🏀", score: "ATL 120 – 118 MIA", sub: "Spread -2.5", outcome: "loss" },
  { top: CARD_TOPS[4], emoji: "⚾", score: "CHC 6 – 3 STL", sub: "Total O/8.5", outcome: "win" },
];

// ---- Wire rows: one per pick, y-centered on its card pair ----
export interface Row {
  ly: number;
  ry: number;
  outcome: Outcome;
}

export const ROWS: Row[] = RESULT_CARDS.map((card) => ({
  ly: card.top + CARD_HEIGHT / 2,
  ry: card.top + CARD_HEIGHT / 2,
  outcome: card.outcome,
}));

// ---- Colors (verbatim from the prototype) ----
export const WIRE_BASE: Record<"neutral" | Outcome, string> = {
  neutral: "#bfdbfe", // faint blue for the capper -> slot leg
  win: "#bbf7d0",
  loss: "#fecaca",
};

export const LIT_IN = "#2563eb"; // blue pulse, capper -> slot
export const LIT_IN_GLOW = "#3b82f6";
export const LIT_OUT: Record<Outcome, string> = { win: "#16a34a", loss: "#dc2626" };

// ---- Cubic bezier wire path, identical to the prototype's path() helper ----
export function wirePath(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

export function inPathFor(row: Row): string {
  return wirePath(LEFT_X, row.ly, CUBE_X - SLOT_HALF, CUBE_Y);
}

export function outPathFor(row: Row): string {
  return wirePath(CUBE_X + SLOT_HALF, CUBE_Y, RIGHT_X, row.ry);
}

// ---- Floating particles near the slot ----
// Positions use Math.random at module load: the whole desktop stage is gated
// behind a post-mount `mode === "desktop"` check, so particles never render on
// the server or on the first client render - there is no hydration to
// mismatch, and the values stay stable across subsequent re-renders.
export interface Particle {
  size: number;
  left: number;
  top: number;
  duration: number;
  delay: number;
}

export const PARTICLES: Particle[] = Array.from({ length: 18 }, () => ({
  size: 2 + Math.random() * 3,
  left: CUBE_X + (Math.random() * 220 - 110),
  top: CUBE_Y + (Math.random() * 160 - 80),
  duration: 5 + Math.random() * 5,
  delay: Math.random() * 6,
}));

export function shuffle<T>(arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
