import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
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
      },
    },
  },
  plugins: [],
};

export default config;
