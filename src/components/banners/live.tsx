import { Flows, Nodes, STANDARD, SharedDefs, glowId, vars, type BannerDef } from "./banner-parts";

// The Live banner (banners/bettingview-live-banner.html): the transmitter icon with its shockwave rings and
// pulsing red core (only this banner has them), five trails, the waveform and the HOME / AWAY chip.
// The text is HTML (page-banner.tsx). No red broadcast icon on the right: the old one is gone.

const T1 = "M62 57 C220 40 380 50 520 52 S800 40 1000 36";
const T2 = "M62 57 C250 64 420 62 560 52 S820 66 1000 68";
const T3 = "M62 57 C200 28 420 24 640 40 S860 56 1000 56";
const T4 = "M62 57 C260 90 520 98 700 66 S880 30 1000 22";
const T5 = "M62 57 C230 70 480 52 700 36 S880 90 1000 78";
const WAVE = "M718 64H786L799 36L814 91L831 52L840 64H873L887 55L896 64H1000";

export const LIVE_BANNER: BannerDef = {
  spec: {
    h: 115,
    rx: 30,
    edge: "#3b82f6",
    shadow: "rgba(59,130,246,.18)",
    ink: "#0b2a6b",
    // The motto matches the other banners' (STANDARD: size, spacing, color).
    motto: STANDARD.motto,
    div: "#0b2a6b",
    tx: 118,
    baseline: 68,
    ts: 29,
    tls: -0.5,
    dh: 26,
    ms: STANDARD.ms,
    mls: STANDARD.mls,
    icon: { cx: 60, cy: 58, r: 27.5 },
  },
  bg: (k) => (
    <>
      <SharedDefs k={k} />
      <defs>
        <linearGradient id={"bnr-bg-" + k} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#e3efff" />
          <stop offset=".45" stopColor="#cfe3fb" />
          <stop offset="1" stopColor="#bcd9fa" />
        </linearGradient>
        <linearGradient id={"bnr-glass-" + k} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".55" />
          <stop offset=".5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={"bnr-rglow-" + k} cx=".1" cy=".5" r=".5">
          <stop offset="0" stopColor="#fff" stopOpacity=".9" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="1000" height="115" fill={`url(#bnr-bg-${k})`} />
      <rect width="1000" height="115" fill={`url(#bnr-glass-${k})`} />
      <rect width="1000" height="115" fill={`url(#bnr-rglow-${k})`} />
      {/* faint grid near waveform */}
      <g stroke="#93c5fd" strokeOpacity=".25" strokeWidth=".5">
        <path d="M718 0V115M780 0V115M850 0V115M920 0V115M718 38H1000M718 76H1000" />
      </g>
      {/* equalizer bars, static */}
      <g fill="#60a5fa" fillOpacity=".35">
        <rect x="22" y="100" width="7" height="15" />
        <rect x="34" y="96" width="7" height="19" />
        <rect x="46" y="98" width="7" height="17" />
        <rect x="64" y="92" width="7" height="23" />
        <rect x="76" y="88" width="7" height="27" />
        <rect x="88" y="80" width="8" height="35" />
        <rect x="100" y="60" width="8" height="55" fillOpacity=".28" />
        <rect x="112" y="40" width="8" height="75" fillOpacity=".22" />
        <rect x="124" y="58" width="8" height="57" fillOpacity=".25" />
        <rect x="136" y="86" width="7" height="29" fillOpacity=".3" />
        <rect x="148" y="96" width="7" height="19" fillOpacity=".25" />
        <rect x="160" y="102" width="6" height="13" fillOpacity=".2" />
        <rect x="172" y="106" width="5" height="9" fillOpacity=".15" />
      </g>
      {/* static base trails */}
      <g fill="none" stroke="#fff" strokeWidth=".9" strokeOpacity=".55">
        <path d={T1} />
        <path d={T2} />
        <path d={T3} strokeOpacity=".4" />
        <path d={T4} />
        <path d={T5} strokeOpacity=".45" />
      </g>
      <Flows
        k={k}
        flows={[
          [T1, "#fff", 1.4, "38s", "-4s"],
          [T2, "#dbeafe", 1.2, "46s", "-19s"],
          [T3, "#fff", 1, "52s", "-31s"],
          [T4, "#bfdbfe", 1.3, "42s", "-11s"],
          [T5, "#fff", 1.1, "58s", "-40s"],
        ]}
      />
      <Nodes
        k={k}
        nodes={[
          [T1, "#fff", "44s", "-6s", "38%"],
          [T4, "#dbeafe", "56s", "-30s", "62%"],
          [T2, "#fff", "50s", "-18s", "22%"],
          [T5, "#dbeafe", "64s", "-50s", "80%"],
          [T3, "#fff", "60s", "-2s", "52%"],
        ]}
      />
    </>
  ),
  art: (k) => (
    <>
      <defs>
        <linearGradient id={"bnr-wave-" + k} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#3b82f6" />
          <stop offset="1" stopColor="#1d4ed8" />
        </linearGradient>
      </defs>
      {/* waveform (static) + subtle traveling highlight */}
      <path d={WAVE} fill="none" stroke={`url(#bnr-wave-${k})`} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path className="bnr-lv-wavehl" pathLength={100} d={WAVE} />
      <g className="bnr-lv-wball">
        <circle r="5" fill="#fff" opacity=".7" filter={`url(#${glowId(k)})`} />
        <circle r="2.3" fill="#fff" />
      </g>
      {/* HOME / AWAY */}
      <rect x="886" y="13" width="100" height="36" rx="9" fill="#fff" fillOpacity=".5" stroke="#fff" strokeOpacity=".8" />
      <g fontSize="9.5" fontWeight="800" fill="#0b3b99" textAnchor="middle">
        <rect x="893" y="19" width="38" height="24" rx="6" fill="#eaf3ff" stroke="#8bb8f0" />
        <text x="912" y="34.5">HOME</text>
        <circle cx="936" cy="31" r="1.6" fill="#0b2a6b" />
        <rect x="941" y="19" width="38" height="24" rx="6" fill="#eaf3ff" stroke="#8bb8f0" />
        <text x="960" y="34.5">AWAY</text>
      </g>
    </>
  ),
  icon: (k) => (
    <>
      {/* transmitter */}
      <circle className="bnr-lv-shock" cx="60" cy="58" r="27.5" style={vars({ "--s": "0s" })} />
      <circle className="bnr-lv-shock" cx="60" cy="58" r="27.5" style={vars({ "--s": "-1.6s" })} />
      <circle className="bnr-lv-shock" cx="60" cy="58" r="27.5" style={vars({ "--s": "-3.2s" })} />
      <circle className="bnr-lv-disc" cx="60" cy="58" r="27.5" fill="#f4f9ff" stroke="#bcd7f8" strokeWidth="1.4" />
      <circle className="bnr-lv-dotglow" cx="60" cy="58" r="8" fill="#ef3b3b" filter={`url(#${glowId(k)})`} />
      <circle className="bnr-lv-dot" cx="60" cy="58" r="4.6" fill="#ef3b3b" />
      <g fill="none" stroke="#0b2a6b" strokeWidth="2.4" strokeLinecap="round">
        <path d="M50.5 49.5a13 13 0 0 0 0 17" />
        <path d="M69.5 49.5a13 13 0 0 1 0 17" />
        <path d="M54.8 52.5a7.5 7.5 0 0 0 0 11" strokeWidth="2" />
        <path d="M65.2 52.5a7.5 7.5 0 0 1 0 11" strokeWidth="2" />
      </g>
      <path className="bnr-div1" d="M100 48V68" stroke="#7ba7e6" strokeWidth=".8" strokeOpacity=".6" />
    </>
  ),
};
