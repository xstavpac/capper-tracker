import { IconDisc, STANDARD, StandardBg, glowId, type BannerDef } from "./banner-parts";

// The Parlay Generator banner (banners/bettingview-parlay-banner.html): bolt icon (soft glow), the parlay
// path a bright ball travels from Leg 1 to the finish bolt. The title, motto and the Parlay slip pill are
// HTML (page-banner.tsx + ParlaySlipPill), placed where the reference draws them, so the counts stay live.

const PATH = "M770 65 C779 43 801 36 812 48 S826 66 836 76 S852 82 862 70 S876 28 902 25 S926 28 936 35";

export const PARLAY_BANNER: BannerDef = {
  spec: { ...STANDARD, tx: 103, baseline: 47, ts: 27.5, dh: 24, controlsTop: 57, icon: { cx: 43, cy: 51.5, r: 22 } },
  bg: (k) => (
    <StandardBg
      k={k}
      t3Opacity=".85"
      t={[
        "M65 51 C230 36 430 50 600 46 S820 28 1000 22",
        "M65 51 C260 62 480 68 650 56 S860 70 1000 74",
        "M372 103 C560 98 720 62 1000 14",
        "M65 51 C220 72 420 82 640 62 S860 22 1000 44",
      ]}
    />
  ),
  art: (k) => (
    <>
      {/* parlay path */}
      <path d={PATH} fill="none" stroke="#6b95dc" strokeWidth="2" strokeLinecap="round" />
      <path className="bnr-pl-hl" pathLength={100} d={PATH} />
      <circle cx="794" cy="44" r="1.8" fill="#6b95dc" />
      <circle cx="857" cy="72" r="1.8" fill="#8aa3cc" />
      <circle cx="924" cy="28" r="1.8" fill="#6b95dc" />
      <g className="bnr-pl-ball">
        <circle r="5" fill="#fff" opacity=".7" filter={`url(#${glowId(k)})`} />
        <circle r="2.2" fill="#fff" />
      </g>

      {/* leg chips (static) */}
      <g fontSize="7.2" fontWeight="800" textAnchor="middle" fill="#3a66ad">
        <rect x="746.5" y="63.5" width="33.5" height="18" rx="5" fill="#fff" stroke="#2f5de0" strokeWidth="1.6" />
        <text x="763" y="75" fill="#1f4fc0">LEG 1</text>
        <rect x="810.5" y="49.5" width="33.5" height="18" rx="5" fill="#fff" stroke="#8fb0e0" strokeWidth="1.1" />
        <text x="827" y="61">LEG 2</text>
        <rect x="867.5" y="43.5" width="33.5" height="18" rx="5" fill="#fff" stroke="#8fb0e0" strokeWidth="1.1" />
        <text x="884" y="55">LEG 3</text>
      </g>

      {/* finish bolt */}
      <circle className="bnr-pl-arrive" cx="959" cy="40" r="20" />
      <circle cx="959" cy="40" r="20" fill="#f4f8ff" stroke="#5b7fc0" strokeWidth="2" />
      <path d="M962 28L952 42H958L955 52L967 37H961L965 28Z" fill="#fbbf24" stroke="#f0a30a" strokeWidth=".8" strokeLinejoin="round" />
    </>
  ),
  icon: () => (
    <>
      <IconDisc cx={43} cy={51.5} divider="M84 31V70" />
      <path className="bnr-lit" d="M46 40L36 54H42.5L40 63L50 49H43.5Z" fill="none" stroke="#1e3a8a" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />
    </>
  ),
};
