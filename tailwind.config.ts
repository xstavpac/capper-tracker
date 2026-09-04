import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  // oracle-background.tsx's pulse sequencer applies these animations
  // imperatively (`el.style.animation = "oracle-travel ..."`), so the class
  // names never appear in source for the content scanner to find. Without
  // safelisting them Tailwind purges the utilities AND their @keyframes,
  // leaving the sequencer setting an animation-name that resolves to nothing
  // (the traveling pulses silently never move). oracle-ambient-pulse /
  // oracle-drift are used as real classes and don't need this.
  safelist: ["animate-oracle-travel", "animate-oracle-glow-flash", "animate-oracle-pass-glow"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eff6ff",
          100: "#dbeafe",
          200: "#bfdbfe",
          300: "#93c5fd",
          400: "#60a5fa",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
          800: "#1e40af",
          900: "#1e3a8a",
        },
        // Semantic tokens backed by the CSS variables in globals.css - swap
        // values per-theme there rather than adding dark: variants per usage.
        background: "rgb(var(--background) / <alpha-value>)",
        foreground: "rgb(var(--foreground) / <alpha-value>)",
        card: {
          DEFAULT: "rgb(var(--card) / <alpha-value>)",
          foreground: "rgb(var(--card-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "rgb(var(--muted) / <alpha-value>)",
          foreground: "rgb(var(--muted-foreground) / <alpha-value>)",
        },
        border: {
          DEFAULT: "rgb(var(--border) / <alpha-value>)",
          subtle: "rgb(var(--border-subtle) / <alpha-value>)",
        },
      },
      borderRadius: {
        card: "16px",
      },
      boxShadow: {
        soft: "0 1px 2px 0 rgb(0 0 0 / 0.04), 0 1px 6px -1px rgb(0 0 0 / 0.04)",
      },
      fontFamily: {
        // Display faces for the marketing "oracle" login background
        // (components/marketing/oracle-background.tsx). Loaded via
        // next/font/google in that component, which sets the CSS variables on
        // its own subtree - these utilities are scoped to that usage.
        orbitron: ["var(--font-orbitron)", "sans-serif"],
        rajdhani: ["var(--font-rajdhani)", "sans-serif"],
      },
      keyframes: {
        "glow-pulse": {
          "0%, 100%": { boxShadow: "0 0 18px 2px rgba(168,85,247,0.55)" },
          "50%": { boxShadow: "0 0 34px 6px rgba(168,85,247,0.9)" },
        },
        "glow-pulse-compact": {
          "0%, 100%": { boxShadow: "0 0 8px 1px rgba(168,85,247,0.55)" },
          "50%": { boxShadow: "0 0 16px 2px rgba(168,85,247,0.9)" },
        },
        "fill-bar": {
          from: { transform: "scaleX(0)" },
          to: { transform: "scaleX(var(--fill, 1))" },
        },
        "trend-surge-up": {
          "0%, 100%": { transform: "translate(0, 0)" },
          "50%": { transform: "translate(2px, -2px)" },
        },
        "trend-surge-down": {
          "0%, 100%": { transform: "translate(0, 0)" },
          "50%": { transform: "translate(2px, 2px)" },
        },
        "trend-glow": {
          "0%, 100%": { filter: "drop-shadow(0 0 0px currentColor)" },
          "50%": { filter: "drop-shadow(0 0 3px currentColor)" },
        },
        "flame-outer": {
          "0%, 100%": { transform: "scale(1, 1) rotate(-3deg)" },
          "50%": { transform: "scale(1.07, 0.95) rotate(3deg)" },
        },
        "flame-inner": {
          "0%, 100%": { transform: "scale(0.55, 0.6) rotate(4deg) translate(1px, 2px)" },
          "50%": { transform: "scale(0.63, 0.5) rotate(-5deg) translate(-1px, 1px)" },
        },
        "ember-rise": {
          "0%": { transform: "translate(0, 0) scale(1)", opacity: "0" },
          "15%": { opacity: "1" },
          "75%": { opacity: "0.4" },
          "100%": { transform: "translate(2px, -14px) scale(0.4)", opacity: "0" },
        },
        "snow-fall-a": {
          "0%": { transform: "translate(0, -6px)", opacity: "0" },
          "15%": { opacity: "1" },
          "85%": { opacity: "1" },
          "100%": { transform: "translate(3px, 12px)", opacity: "0" },
        },
        "snow-fall-b": {
          "0%": { transform: "translate(0, -6px)", opacity: "0" },
          "15%": { opacity: "1" },
          "85%": { opacity: "1" },
          "100%": { transform: "translate(-3px, 12px)", opacity: "0" },
        },
        "rocket-drift": {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-2px)" },
        },
        "thrust-flicker": {
          "0%, 100%": { opacity: "0.9" },
          "50%": { opacity: "0.35" },
        },
        "parachute-sway": {
          "0%, 100%": { transform: "rotate(-4deg)" },
          "50%": { transform: "rotate(4deg)" },
        },
        "energy-ring": {
          "0%": { transform: "scale(0.55)", opacity: "0.9" },
          "100%": { transform: "scale(2.1)", opacity: "0" },
        },
        // Sharp, uneven opacity swings (not a smooth fade) so it reads as an
        // electrical crackle rather than a twinkle - stops end at 0 so the
        // bolt is gone by the time the one-shot animation completes.
        "energy-bolt-crackle": {
          "0%": { opacity: "1" },
          "12%": { opacity: "0.15" },
          "24%": { opacity: "1" },
          "38%": { opacity: "0" },
          "50%": { opacity: "1" },
          "66%": { opacity: "0.25" },
          "80%": { opacity: "1" },
          "100%": { opacity: "0" },
        },
        "energy-flash": {
          "0%": { transform: "translate(0, 0)", color: "var(--surge-color)" },
          "10%": { transform: "translate(-2px, 1px)", color: "#22d3ee" },
          "20%": { transform: "translate(2px, -1px)", color: "var(--surge-color)" },
          "30%": { transform: "translate(-1px, -2px)", color: "#22d3ee" },
          "40%": { transform: "translate(1px, 2px)", color: "var(--surge-color)" },
          "50%": { transform: "translate(-2px, 0)", color: "#22d3ee" },
          "62%": { transform: "translate(0, 0)", color: "var(--surge-color)" },
          "100%": { transform: "translate(0, 0)", color: "var(--surge-color)" },
        },
        // Marketing live-ticker marquee - the track renders its game list
        // TWICE back to back, so scrolling exactly 50% of the track's total
        // width brings the second copy flush into the first copy's starting
        // position, making the loop seamless (no snap-back visible).
        "ticker-scroll": {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
        // --- Marketing "oracle" login background (oracle-background.tsx) ---
        // The pulse legs (oracle-travel / oracle-glow-flash / oracle-pass-glow)
        // are (re)triggered imperatively from that component's sequencer via
        // `el.style.animation` using these keyframe names. Tailwind only emits a
        // @keyframes rule when its `animate-*` utility survives content
        // purging, so those three utilities are safelisted above (their class
        // names never appear in source). oracle-drift / oracle-ambient-pulse
        // are applied as real `animate-*` classes and need no safelist entry.
        "oracle-travel": {
          "0%": { offsetDistance: "0%", opacity: "0" },
          "6%": { opacity: "1" },
          "94%": { opacity: "1" },
          "100%": { offsetDistance: "100%", opacity: "0" },
        },
        "oracle-glow-flash": {
          "0%": { opacity: "0" },
          "15%": { opacity: "1" },
          "85%": { opacity: "1" },
          "100%": { opacity: "0" },
        },
        "oracle-pass-glow": {
          "0%, 100%": { opacity: "0.6" },
          "50%": { opacity: "1", filter: "brightness(1.4)" },
        },
        "oracle-ambient-pulse": {
          "0%, 100%": { opacity: "0.6", transform: "scale(0.94)" },
          "50%": { opacity: "1", transform: "scale(1.05)" },
        },
        "oracle-drift": {
          "0%": { transform: "translateY(0) scale(0.6)", opacity: "0" },
          "15%": { opacity: "0.7" },
          "85%": { opacity: "0.5" },
          "100%": { transform: "translateY(-70px) scale(1)", opacity: "0" },
        },
      },
      animation: {
        "glow-pulse": "glow-pulse 2.2s ease-in-out infinite",
        "glow-pulse-compact": "glow-pulse-compact 2.2s ease-in-out infinite",
        "fill-bar": "fill-bar 0.8s ease-out",
        "trend-surge-up": "trend-surge-up 1.6s ease-in-out infinite",
        "trend-surge-down": "trend-surge-down 1.6s ease-in-out infinite",
        "trend-glow": "trend-glow 1.6s ease-in-out infinite",
        "flame-outer": "flame-outer 1.6s ease-in-out infinite",
        "flame-inner": "flame-inner 1.1s ease-in-out infinite",
        "ember-rise": "ember-rise 1.8s ease-out infinite",
        "snow-fall-a": "snow-fall-a 2.4s linear infinite",
        "snow-fall-b": "snow-fall-b 2.8s linear infinite",
        "rocket-drift": "rocket-drift 2.4s ease-in-out infinite",
        "thrust-flicker": "thrust-flicker 0.9s ease-in-out infinite",
        "parachute-sway": "parachute-sway 2.6s ease-in-out infinite",
        // One-shot (iteration-count 1, no infinite) - these play once, before
        // the count-up starts (see energy-surge.tsx's SURGE_DURATION_MS,
        // which must stay in sync with this ring duration + the component's
        // RINGS stagger array - it's what the count-up waits for).
        "energy-ring": "energy-ring 0.7s ease-out 1 both",
        "energy-bolt-crackle": "energy-bolt-crackle 0.6s ease-in-out 1 both",
        "energy-flash": "energy-flash 0.65s ease-in-out 1 both",
        // Duration is a fixed pace, not tied to game count - a slow-scanning
        // read speed regardless of how many games are on the slate that day.
        "ticker-scroll": "ticker-scroll 45s linear infinite",
        // oracle-background.tsx - see the keyframes note above. travel/glow-flash
        // durations here are placeholders; the sequencer sets its own timing
        // (IN_DUR / OUT_DUR / CUBE_DUR in oracle-background-constants.ts) when
        // it assigns el.style.animation.
        "oracle-travel": "oracle-travel 2.2s linear forwards",
        "oracle-glow-flash": "oracle-glow-flash 2.2s ease-in-out forwards",
        "oracle-pass-glow": "oracle-pass-glow 0.8s ease-in-out",
        "oracle-ambient-pulse": "oracle-ambient-pulse 5s ease-in-out infinite",
        "oracle-drift": "oracle-drift 8s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
