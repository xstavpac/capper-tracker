import { IconDisc, STANDARD, StandardBg, glowId, softId, vars, type BannerDef } from "./banner-parts";

// The Charts banner (banners/bettingview-charts-banner.html): chart icon (soft glow) and the chart card, a
// bright ball leading a light streak along each line; the blue line's endpoint glows on arrival.
// The text is HTML (page-banner.tsx).

const BLUE = "M786.6 79L809.4 66.6L832 71L854.8 53.6L877.5 58.5L901.3 41.2L924 45.5L948.5 29.8L959.4 28.2";
const PURPLE = "M786.6 72.6L809.4 75.8L832 62.8L854.8 67.2L877.5 51.5L901.3 55.8L924 53.6L948.5 46.6L959.4 48.8";

export const CHARTS_BANNER: BannerDef = {
  spec: { ...STANDARD, tx: 102.5, baseline: 63.5, ts: 27.5, dh: 23.5, icon: { cx: 43, cy: 51.5, r: 22 } },
  bg: (k) => (
    <StandardBg
      k={k}
      t3Opacity=".85"
      t={[
        "M65 51 C230 36 430 50 600 46 S820 28 1000 22",
        "M65 51 C260 62 480 68 650 56 S860 70 1000 74",
        "M371 103 C560 98 720 62 1000 13.5",
        "M65 51 C220 72 420 82 640 62 S860 22 1000 44",
      ]}
    />
  ),
  art: (k) => (
    <>
      <defs>
        <linearGradient id={"bnr-area-" + k} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#9fc0f2" stopOpacity=".45" />
          <stop offset="1" stopColor="#dbe9fb" stopOpacity=".1" />
        </linearGradient>
      </defs>
      {/* dotted sparklines */}
      <g fill="none" stroke="#6b9be0" strokeWidth="1" strokeDasharray="1.5 2.5" strokeLinecap="round">
        <path d="M722 85L745 70L760.5 74" />
        <path d="M975 67.7L987 44.4L998 29" />
      </g>
      <circle cx="745" cy="70" r="2" fill="#6b9be0" />
      <circle cx="987" cy="44.4" r="2.2" fill="#6b9be0" />

      {/* chart card (static) */}
      <rect x="774" y="11.4" width="196" height="84" rx="8" fill="#fff" fillOpacity=".9" stroke="#9bbdea" />
      <g stroke="#cfdcf0" strokeWidth=".7">
        <path d="M787 33H960M787 51.5H960M787 70H960" />
      </g>
      <path d={BLUE + "V90H786.6Z"} fill={`url(#bnr-area-${k})`} />
      <path d={PURPLE} fill="none" stroke="#8b5cf6" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
      <path d={BLUE} fill="none" stroke="#2f5de0" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />

      {/* chart motion */}
      <g style={{ filter: `url(#${softId(k)})` }}>
        <path className="bnr-ch-hl" pathLength={100} d={BLUE} style={vars({ "--s": "0s" })} />
        <path className="bnr-ch-hl" pathLength={100} d={PURPLE} style={vars({ "--s": "-4.5s", strokeOpacity: ".8" })} />
      </g>
      <circle cx="959.4" cy="28.2" r="2.4" fill="#2f5de0" />
      <circle className="bnr-ch-arrive" cx="959.4" cy="28.2" r="2.4" />
      <g className="bnr-ch-ball" style={{ offsetPath: `path('${BLUE}')`, ...vars({ "--s": "0s" }) }}>
        <circle r="5" fill="#fff" opacity=".7" filter={`url(#${glowId(k)})`} />
        <circle r="2.2" fill="#fff" />
      </g>
      <g className="bnr-ch-ball" style={{ offsetPath: `path('${PURPLE}')`, ...vars({ "--s": "-4.5s" }) }}>
        <circle r="4" fill="#fff" opacity=".6" filter={`url(#${glowId(k)})`} />
        <circle r="1.8" fill="#fff" />
      </g>
    </>
  ),
  icon: () => (
    <>
      <IconDisc cx={43} cy={51.5} divider="M84 32V71" />
      <g className="bnr-lit" fill="none" stroke="#1e3a8a" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M36 42V60H51" />
        <path d="M39.5 55L44 50L47 53L51 46.5" />
        <circle cx="51" cy="46" r="1.7" fill="#1e3a8a" />
      </g>
    </>
  ),
};
