import { IconDisc, STANDARD, StandardBg, glowId, softId, vars, type BannerDef } from "./banner-parts";

// The Picks banner (banners/bettingview-picks-banner.html): clipboard icon (soft glow), basketball, football
// and the pick card whose rows a bright ball scans in turn. The text is HTML (page-banner.tsx).

const ROWS: [string, string][] = [
  ["M876 30H939", "0s"],
  ["M872 50H921", "-7.8s"],
  ["M871 72H928", "-6.6s"],
];

export const PICKS_BANNER: BannerDef = {
  spec: { ...STANDARD, tx: 103, baseline: 63, ts: 29, dh: 23, icon: { cx: 43, cy: 51, r: 22 } },
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
      {/* basketball */}
      <circle cx="768" cy="63" r="15" fill="#eaf3ff" fillOpacity=".7" stroke="#6b9be0" strokeWidth="1.2" />
      <path d="M768 48V78M753 63H783M758 52C764 58 764 68 758 74M778 52C772 58 772 68 778 74" fill="none" stroke="#6b9be0" strokeWidth="1" />

      {/* pick cards */}
      <rect x="794" y="22" width="54" height="73" rx="5" fill="#fff" fillOpacity=".5" stroke="#b8d0ee" transform="rotate(-3 821 58)" />
      <g transform="rotate(4 904 52)">
        <rect x="843.5" y="12" width="121" height="80" rx="6" fill="#fff" fillOpacity=".92" stroke="#a9c6ee" />
        <g fill="#22c55e">
          <circle cx="860" cy="28" r="6" />
          <circle cx="860" cy="49" r="6" />
        </g>
        <g fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M857 28l2.2 2.2 3.8-4" />
          <path d="M857 49l2.2 2.2 3.8-4" />
        </g>
        <circle cx="860" cy="70" r="5.6" fill="none" stroke="#3a5fa8" strokeWidth="1.2" />
        <g strokeLinecap="round" strokeWidth="2.8">
          <path d="M876 30H939" stroke="#6d9be0" />
          <path d="M944 31H958" stroke="#7fa6e6" />
          <path d="M872 50H921" stroke="#6d9be0" />
          <path d="M944 52H958" stroke="#7fa6e6" />
          <path d="M871 72H928" stroke="#a5c0ea" />
          <path d="M943 73H957" stroke="#b5ccee" />
        </g>
        <circle className="bnr-pk-tick" cx="860" cy="28" r="6" style={vars({ "--s": "0s" })} />
        <circle className="bnr-pk-tick" cx="860" cy="49" r="6" style={vars({ "--s": "-2.5s" })} />
        <g style={{ filter: `url(#${softId(k)})` }}>
          {ROWS.map(([d, s]) => (
            <path key={d} className="bnr-pk-row" pathLength={100} d={d} style={vars({ "--s": s })} />
          ))}
        </g>
        {ROWS.map(([d, s]) => (
          <g key={d} className="bnr-pk-rball" style={{ offsetPath: `path('${d}')`, ...vars({ "--s": s }) }}>
            <circle r="4" fill="#fff" opacity=".7" filter={`url(#${glowId(k)})`} />
            <circle r="1.8" fill="#fff" />
          </g>
        ))}
      </g>

      {/* football */}
      <g transform="translate(981 78) rotate(-20)">
        <ellipse rx="14.6" ry="9.5" fill="#e6f0fd" stroke="#6b9be0" strokeWidth="1.1" />
        <path d="M-4 0H4M-3 -2.2V2.2M0 -2.2V2.2M3 -2.2V2.2" stroke="#6b9be0" strokeWidth=".9" strokeLinecap="round" />
      </g>
    </>
  ),
  icon: () => (
    <>
      <IconDisc cx={43} cy={51} divider="M84 31V70" />
      <g className="bnr-lit" fill="none" stroke="#1e3a8a" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="35.5" y="41.5" width="15" height="19" rx="3" />
        <rect x="40" y="39.5" width="6" height="3.5" rx="1" fill="#f4f8ff" />
        <path d="M39 48l1.2 1.2 1.9-2.2M39 53l1.2 1.2 1.9-2.2" />
        <path d="M44.5 48H48M44.5 53H48" />
        <rect x="39" y="56.5" width="2.8" height="2.8" rx=".6" />
      </g>
    </>
  ),
};
