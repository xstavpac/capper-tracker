import type { CSSProperties, ReactNode } from "react";

// Shared SVG pieces of the page banners (banners/bettingview-*-banner.html). Geometry, colours, durations
// and delays are copied from the reference files; the keyframes are in banner-shared.css.
// `k` makes every <defs> id unique per SVG (each banner draws a background SVG, an art SVG and, below
// 900px, a small icon SVG, and each has its own defs).

export type BannerVariant = "dashboard" | "cappers" | "picks" | "parlay" | "live" | "charts" | "import";

// Where the HTML text sits, in reference units (the viewBox is 1000 wide).
export type BannerSpec = {
  h: number; // viewBox height
  rx: number; // corner radius
  edge: string; // border colour
  shadow: string; // drop-shadow colour
  ink: string; // title colour
  motto: string; // motto colour
  div: string; // colour of the divider between title and motto
  tx: number; // title x
  baseline: number; // title baseline y
  ts: number; // title font size
  tls: number; // title letter-spacing
  dh: number; // divider height
  ms: number; // motto font size
  mls: number; // motto letter-spacing
  controlsTop?: number; // top of the controls row (Cappers tabs, Parlay slip pill)
  icon: { cx: number; cy: number; r: number }; // the icon disc, for the phone-width icon's viewBox
};

export type BannerDef = {
  spec: BannerSpec;
  bg: (k: string) => ReactNode; // background, trails, flowing light, nodes
  art: (k: string) => ReactNode; // the page art on the right
  icon: (k: string) => ReactNode; // the page icon at the left, with its divider
};

// CSS custom properties in a React style object.
export const vars = (o: Record<string, string | number>) => o as unknown as CSSProperties;

export const glowId = (k: string) => "bnr-glow-" + k;
export const softId = (k: string) => "bnr-soft-" + k;

export function SharedDefs({ k }: { k: string }) {
  return (
    <defs>
      <filter id={softId(k)} x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation=".6" />
      </filter>
      <filter id={glowId(k)} x="-300%" y="-300%" width="700%" height="700%">
        <feGaussianBlur stdDeviation="1.6" />
      </filter>
    </defs>
  );
}

// [path, stroke, stroke-width, duration, delay]
export type Flow = [string, string, number, string, string];
// [path, glow fill, duration, delay, reduced-motion position]
export type Node = [string, string, string, string, string];

export function Flows({ k, flows }: { k: string; flows: Flow[] }) {
  return (
    <g filter={`url(#${softId(k)})`}>
      {flows.map(([d, stroke, w, dur, s]) => (
        <path key={d} className="bnr-flow" pathLength={100} d={d} stroke={stroke} strokeWidth={w} style={vars({ "--d": dur, "--s": s })} />
      ))}
    </g>
  );
}

export function Nodes({ k, nodes }: { k: string; nodes: Node[] }) {
  return (
    <g>
      {nodes.map(([d, fill, dur, s, p]) => (
        <g key={d} className="bnr-node" style={{ offsetPath: `path('${d}')`, ...vars({ "--d": dur, "--s": s, "--p": p }) }}>
          <circle r="3.4" fill={fill} opacity=".6" filter={`url(#${glowId(k)})`} />
          <circle r="1.6" fill="#fff" />
        </g>
      ))}
    </g>
  );
}

// The background the six non-Live banners share: gradient, glass, grid, faint bars and rising line, four trails
// (static base + flowing light + gliding nodes). The trail shapes differ a little per banner, so they are passed in.
export function StandardBg({ k, t, t3Opacity }: { k: string; t: [string, string, string, string]; t3Opacity: string }) {
  const [t1, t2, t3, t4] = t;
  const bg = "bnr-bg-" + k;
  const glass = "bnr-glass-" + k;
  return (
    <>
      <SharedDefs k={k} />
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#eaf2fd" />
          <stop offset=".5" stopColor="#d9e8fa" />
          <stop offset="1" stopColor="#c9ddf6" />
        </linearGradient>
        <linearGradient id={glass} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".55" />
          <stop offset=".55" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="1000" height="103" fill={`url(#${bg})`} />
      <rect width="1000" height="103" fill={`url(#${glass})`} />
      <g stroke="#9ec1ee" strokeOpacity=".22" strokeWidth=".5">
        <path d="M0 26H1000M0 52H1000M0 78H1000M120 0V103M260 0V103M400 0V103M540 0V103M680 0V103" />
      </g>
      <g fill="#8db6ee" fillOpacity=".25">
        <rect x="8" y="64" width="9" height="39" />
        <rect x="21" y="48" width="9" height="55" />
        <rect x="63" y="72" width="9" height="31" />
        <rect x="76" y="62" width="9" height="41" />
        <rect x="106" y="80" width="8" height="23" />
        <rect x="118" y="88" width="8" height="15" />
      </g>
      <path d="M75 45L115 14L148 2" fill="none" stroke="#a9c6ee" strokeWidth="1" strokeOpacity=".8" />

      {/* static trails */}
      <g fill="none" stroke="#fff" strokeWidth=".9" strokeOpacity=".6">
        <path d={t1} />
        <path d={t2} strokeOpacity=".45" />
        <path d={t4} strokeOpacity=".5" />
      </g>
      <path d={t3} fill="none" stroke="#7aa9e6" strokeWidth="1.1" strokeOpacity={t3Opacity} />

      <Flows
        k={k}
        flows={[
          [t1, "#fff", 1.4, "40s", "-6s"],
          [t2, "#dbeafe", 1.2, "50s", "-24s"],
          [t3, "#fff", 1.3, "34s", "-12s"],
          [t4, "#bfdbfe", 1.1, "58s", "-38s"],
        ]}
      />
      <Nodes
        k={k}
        nodes={[
          [t1, "#fff", "46s", "-8s", "34%"],
          [t2, "#dbeafe", "56s", "-30s", "58%"],
          [t3, "#fff", "40s", "-20s", "46%"],
          [t4, "#dbeafe", "64s", "-50s", "22%"],
        ]}
      />
    </>
  );
}

// The icon disc of the six non-Live banners, and the thin divider right of it.
export function IconDisc({ cx, cy, divider }: { cx: number; cy: number; divider: string }) {
  return (
    <>
      <circle cx={cx} cy={cy} r="22" fill="#f4f8ff" stroke="#8fb0e0" strokeWidth="1.4" />
      <path className="bnr-div1" d={divider} stroke="#9db8e2" strokeWidth=".9" />
    </>
  );
}

// The common spec of the six non-Live banners.
export const STANDARD = {
  h: 103,
  rx: 27,
  edge: "#8fb0e0",
  shadow: "rgba(59,130,246,.16)",
  ink: "#0f2352",
  motto: "#1e4a96",
  div: "#4a6ea8",
  tls: -0.4,
  ms: 8.8,
  mls: 2.5,
} as const;
