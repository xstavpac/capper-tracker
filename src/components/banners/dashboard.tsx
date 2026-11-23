import { IconDisc, STANDARD, StandardBg, glowId, vars, type BannerDef } from "./banner-parts";

// The Dashboard banner (banners/bettingview-dashboard-banner.html): grid icon with the shared slow glow,
// and the mini dashboard card with its trend line and donut. The text is HTML (page-banner.tsx).

export const DASHBOARD_BANNER: BannerDef = {
  spec: { ...STANDARD, tx: 103, baseline: 64, ts: 27, dh: 24, mls: 2.3, icon: { cx: 43, cy: 51, r: 22 } },
  bg: (k) => (
    <StandardBg
      k={k}
      t3Opacity=".8"
      t={[
        "M65 51 C230 38 430 50 600 48 S820 30 1000 24",
        "M65 51 C260 60 480 66 650 54 S860 70 1000 74",
        "M300 103 C520 96 700 70 1000 28",
        "M65 51 C220 70 420 80 640 60 S860 20 1000 40",
      ]}
    />
  ),
  art: (k) => (
    <>
      <defs>
        <linearGradient id={"bnr-bar-" + k} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4f8fe8" />
          <stop offset="1" stopColor="#cfe2fa" />
        </linearGradient>
      </defs>
      {/* dotted sparklines */}
      <g fill="none" stroke="#6b9be0" strokeWidth="1" strokeDasharray="1.5 2.5" strokeLinecap="round">
        <path d="M739 85L765 68L779 73" />
        <path d="M965 68L982 39L1000 22" />
      </g>
      <circle cx="765" cy="68" r="2" fill="#6b9be0" />
      <circle cx="982" cy="39" r="2.2" fill="#6b9be0" />

      {/* mini dashboard card */}
      <rect x="785" y="13.5" width="172" height="82" rx="10" fill="#fff" fillOpacity=".85" stroke="#9bbdea" />
      <g>
        <rect x="794" y="22" width="46" height="17" rx="4" fill="#f1f6fe" stroke="#b9d0ee" strokeWidth=".7" />
        <rect x="847" y="22" width="46" height="17" rx="4" fill="#f1f6fe" stroke="#b9d0ee" strokeWidth=".7" />
        <rect x="898" y="22" width="51" height="17" rx="4" fill="#f1f6fe" stroke="#b9d0ee" strokeWidth=".7" />
        <path d="M799 28H811" stroke="#5b8fd6" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M799 33H807" stroke="#22c55e" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M852 28H864" stroke="#5b8fd6" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M852 33H860" stroke="#22c55e" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M903 28H915" stroke="#5b8fd6" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M903 33H911" stroke="#f87171" strokeWidth="1.4" strokeLinecap="round" />
      </g>
      <g fill={`url(#bnr-bar-${k})`}>
        <rect x="798" y="76" width="6" height="12" rx="1" />
        <rect x="808" y="71" width="6" height="17" rx="1" />
        <rect x="818" y="77" width="6" height="11" rx="1" />
        <rect x="828" y="67" width="6" height="21" rx="1" />
        <rect x="838" y="71" width="6" height="17" rx="1" />
        <rect x="848" y="63" width="6" height="25" rx="1" />
        <rect x="858" y="68" width="6" height="20" rx="1" />
        <rect x="868" y="54" width="6" height="34" rx="1" />
      </g>
      <path d="M797 74L838 61L871 46" fill="none" stroke="#2f6fe0" strokeWidth="1.3" strokeLinejoin="round" />
      <path className="bnr-db-trendhl" pathLength={100} d="M797 74L838 61L871 46" />
      <circle cx="838" cy="61" r="2" fill="#2f6fe0" />
      <circle cx="871" cy="46" r="2.6" fill="#2f6fe0" />
      <g className="bnr-db-ball">
        <circle r="5" fill="#fff" opacity=".7" filter={`url(#${glowId(k)})`} />
        <circle r="2.2" fill="#fff" />
      </g>
      {/* donut */}
      <circle cx="922" cy="68" r="16" fill="none" stroke="#5b9be8" strokeWidth="6.5" />
      <circle cx="922" cy="68" r="16" fill="none" stroke="#d3e0f1" strokeWidth="6.5" strokeDasharray="28 72" pathLength={100} transform="rotate(-100 922 68)" />
      <circle cx="922" cy="68" r="16" fill="none" stroke="#8b5cf6" strokeWidth="6.5" strokeDasharray="26 74" pathLength={100} transform="rotate(100 922 68)" />
      <circle className="bnr-flow" cx="922" cy="68" r="16" pathLength={100} stroke="#fff" strokeWidth="1.6" style={vars({ "--d": "16s", "--s": "0s", opacity: ".8" })} transform="rotate(-90 922 68)" />
    </>
  ),
  icon: () => (
    <>
      <IconDisc cx={43} cy={51} divider="M84 32V70" />
      {/* The plain slow glow of the other icons (.bnr-lit), not the reference's squares lighting in turn. */}
      <g className="bnr-lit" fill="none" stroke="#1e3a8a" strokeWidth="1.6">
        <rect x="35" y="43" width="6.5" height="6.5" rx="1.6" />
        <rect x="44.5" y="43" width="6.5" height="6.5" rx="1.6" />
        <rect x="35" y="52.5" width="6.5" height="6.5" rx="1.6" />
        <rect x="44.5" y="52.5" width="6.5" height="6.5" rx="1.6" />
      </g>
    </>
  ),
};
