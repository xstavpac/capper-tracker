import { IconDisc, STANDARD, StandardBg, glowId, type BannerDef } from "./banner-parts";

// The Catalog Import banner (banners/bettingview-catalog-import-banner.html): download icon (soft glow), a
// scan down the pasted page, a ball across the arrow, then the result rows appear with their checks.
// The text is HTML (page-banner.tsx).

export const IMPORT_BANNER: BannerDef = {
  spec: { ...STANDARD, tx: 102.5, baseline: 63.5, ts: 27.5, dh: 23, icon: { cx: 43, cy: 51.5, r: 22 } },
  bg: (k) => (
    <StandardBg
      k={k}
      t3Opacity=".85"
      t={[
        "M65 51 C230 36 430 50 600 46 S820 28 1000 22",
        "M65 51 C260 62 480 68 650 56 S860 70 1000 74",
        "M373 103 C560 98 720 62 1000 15",
        "M65 51 C220 72 420 82 640 62 S860 22 1000 44",
      ]}
    />
  ),
  art: (k) => (
    <>
      {/* dotted sparklines */}
      <g fill="none" stroke="#6b9be0" strokeWidth="1" strokeDasharray="1.5 2.5" strokeLinecap="round">
        <path d="M710 85L733 70L748 76" />
        <path d="M976 67L988 44L1000 30" />
      </g>
      <circle cx="733" cy="70" r="2" fill="#6b9be0" />
      <circle cx="988" cy="44" r="2.2" fill="#6b9be0" />

      {/* pasted document + scan */}
      <defs>
        <clipPath id={"bnr-docclip-" + k}>
          <rect x="757" y="17" width="70" height="72" rx="5" />
        </clipPath>
        <linearGradient id={"bnr-scang-" + k} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset=".8" stopColor="#fff" stopOpacity=".9" />
          <stop offset="1" stopColor="#5b8fd6" stopOpacity=".9" />
        </linearGradient>
      </defs>
      <g transform="rotate(-5 792 53)">
        <rect x="757" y="17" width="70" height="72" rx="5" fill="#fff" fillOpacity=".92" stroke="#9bbdea" />
        <g strokeLinecap="round" strokeWidth="2.4">
          <path d="M765 31H807" stroke="#8fb0e0" />
          <path d="M765 39H814" stroke="#a9c6ee" />
          <path d="M765 49H803" stroke="#a9c6ee" />
          <path d="M765 57H811" stroke="#a9c6ee" />
          <path d="M765 66H799" stroke="#b9d0ee" />
        </g>
        <g clipPath={`url(#bnr-docclip-${k})`}>
          <rect className="bnr-im-scan" x="757" y="5" width="70" height="12" fill={`url(#bnr-scang-${k})`} />
        </g>
      </g>

      {/* arrow (dashes march slowly) */}
      <path className="bnr-im-march" d="M838 53H864" fill="none" stroke="#2f5de0" strokeWidth="1.6" strokeDasharray="3 2" />
      <path d="M861 48.5L867 53L861 57.5" fill="none" stroke="#2f5de0" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <g className="bnr-im-ab">
        <circle r="4.5" fill="#fff" opacity=".7" filter={`url(#${glowId(k)})`} />
        <circle r="2" fill="#fff" />
      </g>

      {/* result card: rows appear one by one */}
      <rect x="875" y="13.5" width="94" height="80.5" rx="8" fill="#fff" fillOpacity=".92" stroke="#9bbdea" />
      <g className="bnr-im-rw bnr-im-a">
        <rect x="883" y="22.5" width="79" height="17" rx="4" fill="#f1f6fe" stroke="#c4d7f1" strokeWidth=".7" />
        <circle cx="891.5" cy="31" r="4.2" fill="#22c55e" />
        <path d="M889.5 31l1.4 1.5 2.6-3" fill="none" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M900 31H935" stroke="#6d9be0" strokeWidth="2.6" strokeLinecap="round" />
        <path d="M941 31H955" stroke="#4a7be0" strokeWidth="2.6" strokeLinecap="round" />
        <circle className="bnr-im-tick bnr-im-a" cx="891.5" cy="31" r="4.2" />
      </g>
      <g className="bnr-im-rw bnr-im-b">
        <rect x="883" y="44.5" width="79" height="17" rx="4" fill="#f1f6fe" stroke="#c4d7f1" strokeWidth=".7" />
        <circle cx="891.5" cy="53" r="4.2" fill="#22c55e" />
        <path d="M889.5 53l1.4 1.5 2.6-3" fill="none" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M900 53H928" stroke="#6d9be0" strokeWidth="2.6" strokeLinecap="round" />
        <path d="M941 53H955" stroke="#4a7be0" strokeWidth="2.6" strokeLinecap="round" />
        <circle className="bnr-im-tick bnr-im-b" cx="891.5" cy="53" r="4.2" />
      </g>
      <g className="bnr-im-rw bnr-im-c">
        <rect x="883" y="66.5" width="79" height="17" rx="4" fill="#f1f6fe" fillOpacity=".5" stroke="#c4d7f1" strokeOpacity=".5" strokeWidth=".7" />
        <circle cx="891.5" cy="75" r="4.2" fill="#bfe8cd" />
        <path d="M889.5 75l1.4 1.5 2.6-3" fill="none" stroke="#fff" strokeOpacity=".8" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M900 75H935" stroke="#c9daf2" strokeWidth="2.6" strokeLinecap="round" />
        <path d="M941 75H955" stroke="#c9daf2" strokeWidth="2.6" strokeLinecap="round" />
      </g>
    </>
  ),
  icon: () => (
    <>
      <IconDisc cx={43} cy={51.5} divider="M84 32V71" />
      <g className="bnr-lit" fill="none" stroke="#1e3a8a" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M43 42V55M37.5 49.5L43 55L48.5 49.5M36 60H50" />
      </g>
    </>
  ),
};
