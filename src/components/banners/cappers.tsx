import { IconDisc, STANDARD, StandardBg, glowId, vars, type BannerDef } from "./banner-parts";

// The Cappers banner (banners/bettingview-cappers-banner.html): crown icon (soft glow), the podium with its
// halo, stars and the ball climbing the dotted line. The title and the time-range tabs are HTML
// (page-banner.tsx + CappersTimeTabs), placed where the reference draws them, so the tabs stay live links.

const USER = (x: number, y: number, s: number, fill: string) => (
  <svg x={x} y={y} width={s} height={s} viewBox="-10 -10 20 20" fill={fill}>
    <circle cx="0" cy="-3" r="3.6" />
    <path d="M-6.5 7.5C-6.5 2.5 6.5 2.5 6.5 7.5Z" />
  </svg>
);

export const CAPPERS_BANNER: BannerDef = {
  spec: { ...STANDARD, tx: 102, baseline: 49, ts: 29, dh: 0, controlsTop: 58, icon: { cx: 43, cy: 52, r: 22 } },
  bg: (k) => (
    <StandardBg
      k={k}
      t3Opacity=".85"
      t={[
        "M65 51 C230 36 430 50 600 46 S820 28 1000 22",
        "M65 51 C260 62 480 68 650 56 S860 70 1000 74",
        "M372 103 C560 98 720 62 1000 15",
        "M65 51 C220 72 420 82 640 62 S860 22 1000 44",
      ]}
    />
  ),
  art: (k) => (
    <>
      <defs>
        <linearGradient id={"bnr-pod-" + k} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#b9d4f7" />
          <stop offset="1" stopColor="#dbe9fb" />
        </linearGradient>
      </defs>
      {/* stars + dotted rise */}
      <path className="bnr-cp-star" style={vars({ "--s": "0s" })} fill="#6b9be0" d="M762 34.5l1.8 3.7 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4-2.9-2.8 4-.6z" />
      <path className="bnr-cp-star" style={vars({ "--s": "-3.5s" })} fill="#aac4ea" d="M976 26.5l1.5 3 3.3.5-2.4 2.3.6 3.3-3-1.6-3 1.6.6-3.3-2.4-2.3 3.3-.5z" />
      <path d="M748 84L775 73L796 77L857 61L882 40L935 42L986 16" fill="none" stroke="#6b9be0" strokeWidth="1" strokeDasharray="1.5 2.5" strokeLinecap="round" />
      <path className="bnr-cp-hl" pathLength={100} d="M748 84L775 73L796 77L857 61L882 40L935 42L986 16" />
      <g className="bnr-cp-ball">
        <circle r="5" fill="#fff" opacity=".7" filter={`url(#${glowId(k)})`} />
        <circle r="2.2" fill="#fff" />
      </g>

      {/* podium */}
      <g fill={`url(#bnr-pod-${k})`} stroke="#7ea8e0" strokeWidth="1">
        <rect x="792" y="63" width="55" height="39" rx="2.5" />
        <rect x="849" y="47" width="56" height="55" rx="2.5" />
        <rect x="907" y="73" width="55" height="29" rx="2.5" />
      </g>
      <g fontWeight="800" textAnchor="middle" fill="#3a66ad" fontFamily="Arial,Helvetica,sans-serif">
        <text x="820" y="88" fontSize="12">2</text>
        <text x="934" y="92" fontSize="10.5">3</text>
        <text x="877" y="80" fontSize="16" fill="#0f2352">1</text>
      </g>
      {/* avatars */}
      <circle cx="819" cy="48" r="12" fill="#eef5ff" stroke="#6b9be0" strokeWidth="1.3" />
      {USER(808, 37, 22, "#4f86d8")}
      <circle cx="935" cy="58" r="11" fill="#eef5ff" stroke="#6b9be0" strokeWidth="1.3" />
      {USER(925, 48, 20, "#4f86d8")}
      <circle className="bnr-cp-halo" cx="876" cy="30" r="14" />
      <circle cx="876" cy="30" r="14" fill="#eef5ff" stroke="#2f5db3" strokeWidth="2" />
      {USER(863, 17, 26, "#2f5db3")}
      <path className="bnr-cp-crown" d="M867 14L869 7L872.5 11L876.5 6L880.5 11L884 7L886 14Z" fill="#fbbf24" stroke="#f0a30a" strokeWidth=".7" strokeLinejoin="round" />
    </>
  ),
  icon: () => (
    <>
      <IconDisc cx={43} cy={52} divider="M83 32V70" />
      <g className="bnr-lit" fill="none" stroke="#1e3a8a" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M35 57L34 46L39.5 50.5L43 43.5L46.5 50.5L52 46L51 57Z" />
        <path d="M36 60.5H50" />
      </g>
    </>
  ),
};
