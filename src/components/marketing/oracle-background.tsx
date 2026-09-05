"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Orbitron, Rajdhani } from "next/font/google";
import {
  BADGE_RING_COUNT,
  BADGE_RING_DELAYS_MS,
  BADGE_RING_DURATION_MS,
  CANVAS_H,
  CANVAS_W,
  CAPPER_CARDS,
  CUBE_DUR,
  GAP_MIN,
  GAP_RANGE,
  IN_DUR,
  inPathFor,
  LIT_IN,
  LIT_IN_GLOW,
  LIT_OUT,
  MOBILE_BREAKPOINT,
  OUT_DUR,
  outPathFor,
  PARTICLES,
  RESULT_CARDS,
  ROUND_PAUSE_MIN,
  ROUND_PAUSE_RANGE,
  ROWS,
  shuffle,
  WIRE_BASE,
} from "./oracle-background-constants";

// The two display faces the prototype relied on. next/font/google works in a
// "use client" module and self-hosts the files (no runtime request to Google),
// exposing each as a CSS variable we hang on this component's root only - so
// the utilities `font-orbitron` / `font-rajdhani` (tailwind.config.ts) resolve
// inside this subtree and nowhere else in the app.
const orbitron = Orbitron({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-orbitron",
  display: "swap",
});
const rajdhani = Rajdhani({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-rajdhani",
  display: "swap",
});

const CARD_BASE =
  "absolute box-border h-[78px] w-[250px] rounded-lg border border-[#e2e8f0] bg-white p-[8px_12px] shadow-[0_2px_10px_rgba(15,23,42,0.06)]";

const GRID_MASK = "radial-gradient(circle at 50% 45%, rgba(0,0,0,0.9) 0%, transparent 70%)";

/** Ambient glow that always breathes behind the login slot - purely decorative,
 *  unrelated to any auth state. */
const AMBIENT_GLOW: CSSProperties = {
  background:
    "radial-gradient(circle, rgba(59,130,246,0.20) 0%, rgba(59,130,246,0.06) 45%, transparent 70%)",
};

export function OracleBackground({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  // Fixed length (ROWS.length is a compile-time-constant 5); populated by ref
  // callbacks so the sequencer can drive each element imperatively.
  const glowInRefs = useRef<(SVGPathElement | null)[]>([]);
  const glowOutRefs = useRef<(SVGPathElement | null)[]>([]);
  const dotInRefs = useRef<(SVGCircleElement | null)[]>([]);
  const dotOutRefs = useRef<(SVGCircleElement | null)[]>([]);
  // Flat, indexed [row * BADGE_RING_COUNT + ringIndex] rather than a nested
  // array - both lengths are compile-time constants, and a flat array keeps
  // the ref-callback and the sequencer's lookup below symmetric with the
  // other *Refs arrays above.
  const badgeRingRefs = useRef<(HTMLSpanElement | null)[]>([]);

  // null until mounted: the server render and the first client render both show
  // just the ambient glow + form (no wide diagram), so there is no hydration
  // mismatch and no flash of the 1280-wide layout on a phone.
  const [mode, setMode] = useState<"mobile" | "desktop" | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [scale, setScale] = useState(1);

  // --- Which mode: full diagram (>= 768px) or glow-only (< 768px) ---
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${MOBILE_BREAKPOINT}px)`);
    const update = () => setMode(mq.matches ? "desktop" : "mobile");
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // --- Scale the fixed 1280x720 stage to COVER the container ---
  useEffect(() => {
    if (mode !== "desktop") return;
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) {
        setScale(Math.max(width / CANVAS_W, height / CANVAS_H));
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]);

  // --- Orchestrated, randomized, one-at-a-time pulse sequencing ---
  useEffect(() => {
    if (mode !== "desktop" || reducedMotion) return;

    let cancelled = false;
    const pending = new Set<ReturnType<typeof setTimeout>>();

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          pending.delete(t);
          resolve();
        }, ms);
        pending.add(t);
      });

    const clearLeg = (el: SVGElement | null) => {
      if (!el) return;
      el.style.animation = "none";
      el.style.opacity = "0";
    };

    const clearRing = (el: HTMLSpanElement | null) => {
      if (!el) return;
      el.style.animation = "none";
      el.style.opacity = "0";
    };

    // Sonar-ping arrival confirmation: 2-3 concentric rings, staggered so
    // they ripple outward one after another instead of firing all at once,
    // in the row's own WIN/LOSS color. Fired the instant that row's outbound
    // pulse finishes traveling (see the out-leg below) - never on its own
    // timer, so it can't drift out of sync with the line/dot arrival it's
    // confirming.
    const fireBadgeRipple = (i: number) => {
      for (let ring = 0; ring < BADGE_RING_COUNT; ring++) {
        const el = badgeRingRefs.current[i * BADGE_RING_COUNT + ring];
        if (!el) continue;
        el.style.animation = "none";
        // Force a reflow so the browser actually registers the "none" state
        // before the next line reapplies the animation - without this,
        // re-triggering the identical animation value in the same
        // synchronous call can be coalesced into a no-op restart.
        void el.offsetWidth;
        el.style.animation = `oracle-badge-ring ${BADGE_RING_DURATION_MS}ms ease-out forwards`;
        el.style.animationDelay = `${BADGE_RING_DELAYS_MS[ring]}ms`;
      }
    };

    const firePick = async (i: number) => {
      const glowIn = glowInRefs.current[i];
      const glowOut = glowOutRefs.current[i];
      const dotIn = dotInRefs.current[i];
      const dotOut = dotOutRefs.current[i];

      // leg 1: capper card -> login slot (blue)
      if (glowIn) glowIn.style.animation = `oracle-glow-flash ${IN_DUR}ms ease-in-out forwards`;
      if (dotIn) dotIn.style.animation = `oracle-travel ${IN_DUR}ms linear forwards`;
      await wait(IN_DUR);
      if (cancelled) return;
      clearLeg(glowIn);
      clearLeg(dotIn);

      // brief passthrough flash near the login area (purely decorative)
      if (glowRef.current) {
        glowRef.current.style.animation = `oracle-pass-glow ${CUBE_DUR}ms ease-in-out`;
      }
      await wait(CUBE_DUR);
      if (cancelled) return;
      if (glowRef.current) glowRef.current.style.animation = "";

      // leg 2: login slot -> result card (green for WIN, red for LOSS)
      if (glowOut) glowOut.style.animation = `oracle-glow-flash ${OUT_DUR}ms ease-in-out forwards`;
      if (dotOut) dotOut.style.animation = `oracle-travel ${OUT_DUR}ms linear forwards`;
      await wait(OUT_DUR);
      if (cancelled) return;
      clearLeg(glowOut);
      clearLeg(dotOut);
      // Arrival: the instant the outbound pulse finishes traveling, ping the
      // badge it just reached - one continuous motion (travel -> arrive ->
      // confirm) rather than a separate, independently-timed effect.
      fireBadgeRipple(i);
    };

    const run = async () => {
      while (!cancelled) {
        for (const i of shuffle([0, 1, 2, 3, 4])) {
          await firePick(i);
          if (cancelled) return;
          await wait(GAP_MIN + Math.random() * GAP_RANGE);
          if (cancelled) return;
        }
        await wait(ROUND_PAUSE_MIN + Math.random() * ROUND_PAUSE_RANGE);
      }
    };

    void run();

    return () => {
      cancelled = true;
      pending.forEach(clearTimeout);
      pending.clear();
      for (let i = 0; i < ROWS.length; i++) {
        clearLeg(glowInRefs.current[i]);
        clearLeg(glowOutRefs.current[i]);
        clearLeg(dotInRefs.current[i]);
        clearLeg(dotOutRefs.current[i]);
      }
      for (const ring of badgeRingRefs.current) clearRing(ring);
      if (glowRef.current) glowRef.current.style.animation = "";
    };
  }, [mode, reducedMotion]);

  return (
    <div
      ref={containerRef}
      className="relative min-h-screen w-full overflow-hidden bg-[#f7f9fc]"
    >
      {mode === "desktop" && (
        <div
          aria-hidden
          className={`pointer-events-none absolute left-1/2 top-1/2 origin-center font-rajdhani text-[#0f172a] ${orbitron.variable} ${rajdhani.variable}`}
          style={{
            width: CANVAS_W,
            height: CANVAS_H,
            transform: `translate(-50%, -50%) scale(${scale})`,
          }}
        >
          {/* masked blueprint grid */}
          <div
            className="absolute inset-0"
            style={{
              backgroundImage:
                "linear-gradient(rgba(59,130,246,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(59,130,246,0.06) 1px, transparent 1px)",
              backgroundSize: "40px 40px",
              maskImage: GRID_MASK,
              WebkitMaskImage: GRID_MASK,
            }}
          />

          {/* Column labels sit just above the first card pair. The prototype's
              "WE TURN PICKS INTO PROOF." headline + subtext that used to live
              near the top of the stage were removed - they clipped under
              cover-scaling and weren't needed. The card / wire / cube cluster
              stays centered on CUBE_Y (= stage & viewport center), so nothing
              else needs to move. */}
          <div className="absolute left-[24px] top-[92px] z-[5] text-[13px] font-bold tracking-[2px] text-[#1d4ed8]">
            CAPPERS
          </div>
          <div className="absolute left-[24px] top-[112px] z-[5] text-[11px] tracking-[1px] text-[#94a3b8]">
            UNVERIFIED PICKS
          </div>
          <div className="absolute right-[24px] top-[92px] z-[5] text-right text-[13px] font-bold tracking-[2px] text-[#1d4ed8]">
            LEAGUES
          </div>
          <div className="absolute right-[24px] top-[112px] z-[5] text-right text-[11px] tracking-[1px] text-[#94a3b8]">
            VERIFIED OUTCOMES
          </div>

          {/* wires + traveling pulses (SVG scales with the stage via viewBox) */}
          <svg
            className="absolute left-0 top-0 z-[2]"
            width={CANVAS_W}
            height={CANVAS_H}
            viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
            fill="none"
          >
            {ROWS.map((row, i) => {
              const inD = inPathFor(row);
              const outD = outPathFor(row);
              const litOut = LIT_OUT[row.outcome];
              return (
                <g key={i}>
                  {/* faint always-on wires */}
                  <path d={inD} stroke={WIRE_BASE.neutral} strokeWidth={1.5} />
                  <path d={outD} stroke={WIRE_BASE[row.outcome]} strokeWidth={1.5} />
                  {/* glow overlays - only lit while this pick is firing */}
                  <path
                    ref={(el) => {
                      glowInRefs.current[i] = el;
                    }}
                    d={inD}
                    stroke={LIT_IN}
                    strokeWidth={4}
                    strokeLinecap="round"
                    style={{ opacity: 0, filter: `drop-shadow(0 0 7px ${LIT_IN_GLOW})` }}
                  />
                  <path
                    ref={(el) => {
                      glowOutRefs.current[i] = el;
                    }}
                    d={outD}
                    stroke={litOut}
                    strokeWidth={4}
                    strokeLinecap="round"
                    style={{ opacity: 0, filter: `drop-shadow(0 0 7px ${litOut})` }}
                  />
                  {/* traveling dots - offset-path is in the same 1280x720 user
                      space as the viewBox, so it scales with the stage too */}
                  <circle
                    ref={(el) => {
                      dotInRefs.current[i] = el;
                    }}
                    r={6}
                    fill={LIT_IN}
                    style={{
                      opacity: 0,
                      filter: `drop-shadow(0 0 7px ${LIT_IN_GLOW})`,
                      offsetPath: `path('${inD}')`,
                    }}
                  />
                  <circle
                    ref={(el) => {
                      dotOutRefs.current[i] = el;
                    }}
                    r={6}
                    fill={litOut}
                    style={{
                      opacity: 0,
                      filter: `drop-shadow(0 0 7px ${litOut})`,
                      offsetPath: `path('${outD}')`,
                    }}
                  />
                </g>
              );
            })}
          </svg>

          {/* capper cards (fixed demo data) */}
          {CAPPER_CARDS.map((card) => (
            <div key={card.name} className={`${CARD_BASE} left-[24px]`} style={{ top: card.top }}>
              <div className="text-[14px] font-bold tracking-[0.2px] text-[#0f172a]">{card.name}</div>
              <div className="mt-[6px] font-orbitron text-[15px] font-bold text-[#1d4ed8]">
                {card.pick}
              </div>
              <div className="absolute left-[120px] top-[46px] text-[11px] font-semibold tracking-[0.3px] text-[#3b82f6]">
                {card.matchup}
              </div>
            </div>
          ))}

          {/* result cards - outcomes locked, never change */}
          {RESULT_CARDS.map((card, i) => (
            <div key={card.score} className={`${CARD_BASE} right-[24px]`} style={{ top: card.top }}>
              <span className="absolute left-[10px] top-[22px] text-[24px]">{card.emoji}</span>
              <div className="ml-[36px] text-[14px] font-bold text-[#0f172a]">{card.score}</div>
              <div className="ml-[36px] mt-[4px] text-[11px] text-[#64748b]">{card.sub}</div>
              {/* Positioned (not static), so it's already a valid containing
                  block for the ripple rings below - no extra wrapper needed. */}
              <span
                className={`absolute right-[12px] top-[8px] rounded-[4px] px-[10px] py-[4px] font-orbitron text-[10px] font-bold tracking-[1px] text-white ${
                  card.outcome === "win"
                    ? "bg-[#16A34A] shadow-[0_0_10px_rgba(34,197,94,0.55)]"
                    : "bg-[#EF4444] shadow-[0_0_10px_rgba(239,68,68,0.55)]"
                }`}
              >
                {card.outcome === "win" ? "WIN" : "LOSS"}
                {/* Arrival ripple: 2-3 concentric rings centered on the
                    badge, in its own WIN/LOSS color, fired by the sequencer
                    the instant this row's outbound pulse finishes traveling.
                    Idle (opacity: 0, no animation) the rest of the time -
                    purely a confirmation flourish, never the source of truth
                    for the outcome, which is always the static text above. */}
                {Array.from({ length: BADGE_RING_COUNT }).map((_, ring) => (
                  <span
                    key={ring}
                    aria-hidden="true"
                    ref={(el) => {
                      badgeRingRefs.current[i * BADGE_RING_COUNT + ring] = el;
                    }}
                    className="pointer-events-none absolute left-1/2 top-1/2 h-[22px] w-[22px] -ml-[11px] -mt-[11px] rounded-full border-2 opacity-0"
                    style={{ borderColor: LIT_OUT[card.outcome] }}
                  />
                ))}
              </span>
              <span className="absolute bottom-[8px] right-[14px] text-[9px] tracking-[1px] text-[#94a3b8]">
                FINAL
              </span>
            </div>
          ))}

          {/* drifting particles near the slot */}
          {PARTICLES.map((p, i) => (
            <div
              key={i}
              className="absolute rounded-full bg-[#60a5fa] opacity-0 animate-oracle-drift motion-reduce:hidden"
              style={{
                width: p.size,
                height: p.size,
                left: p.left,
                top: p.top,
                filter: "drop-shadow(0 0 4px #60a5fa)",
                animationDuration: `${p.duration}s`,
                animationDelay: `${p.delay}s`,
              }}
            />
          ))}
        </div>
      )}

      {/* center slot - rendered in BOTH modes, never inside the scaled stage so
          the real form stays crisp and fully interactive */}
      <div className="absolute inset-0 z-10 flex items-center justify-center p-4">
        <div className="relative w-[340px] max-w-full">
          <div
            aria-hidden
            ref={glowRef}
            className="pointer-events-none absolute -inset-10 rounded-full animate-oracle-ambient-pulse motion-reduce:animate-none"
            style={AMBIENT_GLOW}
          />
          <div className="relative">{children}</div>
        </div>
      </div>
    </div>
  );
}
