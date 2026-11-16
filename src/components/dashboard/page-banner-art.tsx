// The right-side SVG art of the page banners, one per variant. Paths, colours, sizes and class names
// are copied from design/page-banners-reference.html; the keyframes behind the bv-* classes are in
// app/globals.css. `uid` makes the <defs> ids unique per banner instance.

export type BannerVariant = "dashboard" | "cappers" | "picks" | "parlay" | "live" | "charts" | "import";

const BLUR = (id: string) => (
  <filter id={id} x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="2" result="b" />
    <feMerge>
      <feMergeNode in="b" />
      <feMergeNode in="SourceGraphic" />
    </feMerge>
  </filter>
);

function DashboardArt({ uid }: { uid: string }) {
  const f = "pbg5-" + uid;
  const g = "dbar-" + uid;
  const bars = [
    [212, 122, 32],
    [230, 112, 42],
    [248, 128, 26],
    [266, 104, 50],
    [284, 116, 38],
    [302, 96, 58],
    [320, 108, 46],
    [338, 88, 66],
  ];
  return (
    <svg width="560" height="180" viewBox="0 0 560 180">
      <defs>
        {BLUR(f)}
        <linearGradient id={g} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="var(--bv-bar-bot)" stopOpacity="var(--bv-bar-bot-op)" />
          <stop offset="1" stopColor="var(--bv-c5)" />
        </linearGradient>
      </defs>
      <g filter={`url(#${f})`}>
        <rect x="190" y="26" width="300" height="140" rx="14" fill="var(--bv-panel)" stroke="var(--bv-c2)" strokeWidth="2" />
        <rect x="206" y="40" width="80" height="30" rx="7" fill="var(--bv-inner)" stroke="var(--bv-c4)" strokeWidth="1.5" />
        <rect x="296" y="40" width="80" height="30" rx="7" fill="var(--bv-inner)" stroke="var(--bv-c4)" strokeWidth="1.5" />
        <rect x="386" y="40" width="88" height="30" rx="7" fill="var(--bv-inner)" stroke="var(--bv-c4)" strokeWidth="1.5" />
        <rect x="214" y="50" width="34" height="5" rx="2.5" fill="var(--bv-c3)" />
        <rect x="214" y="59" width="22" height="4" rx="2" fill="#22C55E" />
        <rect x="304" y="50" width="34" height="5" rx="2.5" fill="var(--bv-c3)" />
        <rect x="304" y="59" width="22" height="4" rx="2" fill="#22C55E" />
        <rect x="394" y="50" width="34" height="5" rx="2.5" fill="var(--bv-c3)" />
        <rect x="394" y="59" width="22" height="4" rx="2" fill="#F87171" />
        <g fill={`url(#${g})`}>
          {bars.map(([x, y, h], i) => (
            <rect key={x} className="bv-bar" style={{ animationDelay: (i * 0.06).toFixed(2) + "s" }} x={x} y={y} width="12" height={h} rx="2" />
          ))}
        </g>
        <polyline className="bv-draw" points="212,128 248,116 284,108 320,92 356,82" fill="none" stroke="var(--bv-c6)" strokeWidth="2" />
        <circle cx="284" cy="108" r="3.5" fill="var(--bv-bright)" />
        <circle className="bv-ping" cx="356" cy="82" r="4.5" fill="var(--bv-ping)" />
        <circle cx="428" cy="118" r="28" fill="none" stroke="var(--bv-grid)" strokeWidth="10" />
        <circle className="bv-donut" cx="428" cy="118" r="28" fill="none" stroke="var(--bv-c5)" strokeWidth="10" strokeDasharray="110 66" transform="rotate(-90 428 118)" />
        <circle cx="428" cy="118" r="28" fill="none" stroke="#7C3AED" strokeWidth="10" strokeDasharray="30 146" strokeDashoffset="-110" transform="rotate(-90 428 118)" />
      </g>
      <polyline points="110,150 150,120 180,128" fill="none" stroke="var(--bv-c5)" strokeWidth="1.5" strokeDasharray="3 5" opacity="0.8" />
      <polyline points="500,120 530,70 560,40" fill="none" stroke="var(--bv-c5)" strokeWidth="1.5" strokeDasharray="3 5" opacity="0.8" />
      <g fill="var(--bv-c2)">
        <circle cx="150" cy="120" r="3" />
        <circle cx="530" cy="70" r="3.5" />
      </g>
    </svg>
  );
}

function CappersArt({ uid }: { uid: string }) {
  const f = "pbg1-" + uid;
  const g = "pod-" + uid;
  return (
    <svg width="560" height="180" viewBox="0 0 560 180">
      <defs>
        {BLUR(f)}
        <linearGradient id={g} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--bv-pod-top)" />
          <stop offset="1" stopColor="var(--bv-pod-bot)" stopOpacity="var(--bv-pod-bot-op)" />
        </linearGradient>
      </defs>
      <g filter={`url(#${f})`}>
        <rect x="200" y="112" width="96" height="68" rx="6" fill={`url(#${g})`} stroke="var(--bv-c3)" strokeWidth="1.5" />
        <rect x="300" y="84" width="96" height="96" rx="6" fill={`url(#${g})`} stroke="var(--bv-c2)" strokeWidth="2" />
        <rect x="400" y="128" width="96" height="52" rx="6" fill={`url(#${g})`} stroke="var(--bv-c3)" strokeWidth="1.5" />
        <circle cx="248" cy="86" r="20" fill="var(--bv-inner)" stroke="var(--bv-c3)" strokeWidth="2" />
        <circle cx="248" cy="80" r="7" fill="var(--bv-c3)" />
        <path d="M235 98a13 9 0 0 1 26 0" fill="var(--bv-c3)" />
        <circle className="bv-ring" cx="348" cy="56" r="23" fill="var(--bv-inner)" stroke="var(--bv-c1)" strokeWidth="2.5" />
        <circle cx="348" cy="49" r="8" fill="var(--bv-c1)" />
        <path d="M333 70a15 10 0 0 1 30 0" fill="var(--bv-c1)" />
        <circle cx="448" cy="102" r="18" fill="var(--bv-inner)" stroke="var(--bv-c3)" strokeWidth="2" />
        <circle cx="448" cy="97" r="6" fill="var(--bv-c3)" />
        <path d="M437 112a11 8 0 0 1 22 0" fill="var(--bv-c3)" />
        <path className="bv-crown" d="M332 26l6 -12 10 9 10 -9 6 12z" fill="#FACC15" stroke="var(--bv-crown-stroke)" strokeWidth="1.5" />
      </g>
      <text x="248" y="156" textAnchor="middle" fontFamily="Inter, sans-serif" fontSize="22" fontWeight="800" fill="var(--bv-c1)">
        2
      </text>
      <text x="348" y="142" textAnchor="middle" fontFamily="Inter, sans-serif" fontSize="28" fontWeight="800" fill="var(--bv-one)">
        1
      </text>
      <text x="448" y="162" textAnchor="middle" fontFamily="Inter, sans-serif" fontSize="20" fontWeight="800" fill="var(--bv-c1)">
        3
      </text>
      <g fill="var(--bv-c2)">
        <path className="bv-star" d="M150 60l3 7 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" />
        <path className="bv-star" style={{ animationDelay: "1s" }} d="M520 50l2.5 5 5.5 1-4 4 1 5.5-5-2.5-5 2.5 1-5.5-4-4 5.5-1z" />
      </g>
      <polyline className="bv-drift" points="120,150 170,128 210,136 260,100 320,108 380,70 450,76 540,30" fill="none" stroke="var(--bv-c5)" strokeWidth="1.5" strokeDasharray="3 5" opacity="0.8" />
    </svg>
  );
}

function PicksArt({ uid }: { uid: string }) {
  const f = "pbg2-" + uid;
  return (
    <svg width="560" height="180" viewBox="0 0 560 180">
      <defs>{BLUR(f)}</defs>
      <g filter={`url(#${f})`}>
        <g transform="rotate(-8 300 100)">
          <rect x="210" y="36" width="190" height="120" rx="12" fill="var(--bv-inner)" stroke="var(--bv-c4)" strokeWidth="1.5" opacity="0.75" />
        </g>
        <g transform="rotate(4 380 96)">
          <rect x="290" y="22" width="210" height="140" rx="12" fill="var(--bv-panel)" stroke="var(--bv-c2)" strokeWidth="2" />
          <g className="bv-pop" style={{ animationDelay: "0.2s" }}>
            <circle cx="318" cy="56" r="11" fill="#22C55E" />
            <path d="M313 56l4 4 7-8" fill="none" stroke="#FFFFFF" strokeWidth="2.4" />
          </g>
          <rect x="340" y="50" width="110" height="8" rx="4" fill="var(--bv-c2)" />
          <rect x="462" y="50" width="24" height="8" rx="4" fill="var(--bv-c3)" />
          <g className="bv-pop" style={{ animationDelay: "0.7s" }}>
            <circle cx="318" cy="92" r="11" fill="#22C55E" />
            <path d="M313 92l4 4 7-8" fill="none" stroke="#FFFFFF" strokeWidth="2.4" />
          </g>
          <rect x="340" y="86" width="90" height="8" rx="4" fill="var(--bv-c2)" />
          <rect x="462" y="86" width="24" height="8" rx="4" fill="var(--bv-c3)" />
          <circle className="bv-pending" cx="318" cy="128" r="11" fill="none" stroke="var(--bv-c3)" strokeWidth="2" />
          <rect x="340" y="122" width="100" height="8" rx="4" fill="var(--bv-c4)" />
          <rect x="462" y="122" width="24" height="8" rx="4" fill="var(--bv-c4)" />
        </g>
        <g className="bv-bob">
          <circle cx="160" cy="118" r="26" fill="var(--bv-inner)" stroke="var(--bv-c3)" strokeWidth="2" />
          <path d="M134 118h52M160 92v52M141 99c10 8 10 30 0 38M179 99c-10 8-10 30 0 38" fill="none" stroke="var(--bv-c3)" strokeWidth="1.5" />
        </g>
        <ellipse cx="530" cy="140" rx="26" ry="16" transform="rotate(-25 530 140)" fill="var(--bv-inner)" stroke="var(--bv-c3)" strokeWidth="2" />
        <path d="M520 140h20M524 136v8M530 136v8M536 136v8" transform="rotate(-25 530 140)" stroke="var(--bv-c2)" strokeWidth="1.5" />
      </g>
    </svg>
  );
}

function ParlayArt({ uid }: { uid: string }) {
  const f = "pbg3-" + uid;
  const chain = "M150 130C190 60 230 60 260 104S330 150 360 92 430 40 470 70";
  return (
    <svg width="560" height="180" viewBox="0 0 560 180">
      <defs>{BLUR(f)}</defs>
      <g filter={`url(#${f})`} fill="none">
        <path d={chain} stroke="var(--bv-c3)" strokeWidth="2.5" />
        <path d={chain} stroke="var(--bv-c5)" strokeWidth="8" opacity="0.18" />
        <path className="bv-chain" d={chain} stroke="var(--bv-bright)" strokeWidth="3.5" strokeLinecap="round" />
      </g>
      <g filter={`url(#${f})`}>
        <rect className="bv-leg bv-leg1" x="122" y="112" width="58" height="34" rx="10" fill="var(--bv-panel)" stroke="var(--bv-c3)" strokeWidth="2" />
        <rect className="bv-leg bv-leg2" x="232" y="88" width="58" height="34" rx="10" fill="var(--bv-panel)" stroke="var(--bv-c3)" strokeWidth="2" />
        <rect className="bv-leg bv-leg3" x="332" y="76" width="58" height="34" rx="10" fill="var(--bv-panel)" stroke="var(--bv-c3)" strokeWidth="2" />
        <g className="bv-bolt">
          <circle cx="490" cy="72" r="34" fill="var(--bv-inner)" stroke="var(--bv-c1)" strokeWidth="2.5" />
          <path className="bv-boltfill" d="M494 48l-16 28h12l-4 22 18-30h-12z" fill="#FACC15" />
        </g>
      </g>
      <g fontFamily="Inter, sans-serif" fontSize="13" fontWeight="800" fill="var(--bv-c1)" textAnchor="middle">
        <text x="151" y="134">LEG 1</text>
        <text x="261" y="110">LEG 2</text>
        <text x="361" y="98">LEG 3</text>
      </g>
      <g fill="var(--bv-c2)">
        <circle cx="205" cy="80" r="3" />
        <circle cx="315" cy="128" r="3" />
        <circle cx="430" cy="52" r="3" />
      </g>
    </svg>
  );
}

function LiveArt({ uid }: { uid: string }) {
  const f = "pbg4-" + uid;
  const pts = "90,112 190,112 214,112 232,62 254,150 276,88 292,112 360,112 378,96 392,112 560,112";
  return (
    <svg width="560" height="180" viewBox="0 0 560 180">
      <defs>{BLUR(f)}</defs>
      <g filter={`url(#${f})`}>
        <polyline points={pts} fill="none" stroke="var(--bv-c5)" strokeWidth="2.5" strokeLinejoin="round" />
        <polyline className="bv-trace" points={pts} fill="none" stroke="var(--bv-bright)" strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round" />
        <rect x="380" y="28" width="150" height="58" rx="10" fill="var(--bv-panel)" stroke="var(--bv-c2)" strokeWidth="2" />
        <rect x="394" y="42" width="54" height="30" rx="6" fill="var(--bv-inner)" stroke="var(--bv-c4)" strokeWidth="1.5" />
        <rect x="462" y="42" width="54" height="30" rx="6" fill="var(--bv-inner)" stroke="var(--bv-c4)" strokeWidth="1.5" />
        <circle cx="455" cy="57" r="3" fill="var(--bv-c2)" />
        <circle className="bv-dot" cx="150" cy="60" r="9" fill="#FF5A5A" />
      </g>
      <g fill="none" stroke="#FF5A5A" strokeWidth="2">
        <g className="bv-wave1">
          <path d="M134 44a22 22 0 0 0 0 32" />
          <path d="M166 44a22 22 0 0 1 0 32" />
        </g>
        <g className="bv-wave2">
          <path d="M124 34a36 36 0 0 0 0 52" />
          <path d="M176 34a36 36 0 0 1 0 52" />
        </g>
      </g>
      <g fontFamily="Inter, sans-serif" fontWeight="800" textAnchor="middle">
        <text x="421" y="62" fontSize="12" fill="var(--bv-c1)">HOME</text>
        <text x="489" y="62" fontSize="12" fill="var(--bv-c1)">AWAY</text>
      </g>
    </svg>
  );
}

function ChartsArt({ uid }: { uid: string }) {
  const f = "pbgc-" + uid;
  const g = "carea-" + uid;
  return (
    <svg width="560" height="180" viewBox="0 0 560 180">
      <defs>
        {BLUR(f)}
        <linearGradient id={g} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--bv-c3)" stopOpacity="0.45" />
          <stop offset="1" stopColor="var(--bv-c3)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g filter={`url(#${f})`}>
        <rect x="170" y="22" width="340" height="146" rx="14" fill="var(--bv-panel)" stroke="var(--bv-c2)" strokeWidth="2" />
        <g stroke="var(--bv-grid)" strokeWidth="1">
          <path d="M190 60H490M190 92H490M190 124H490" />
        </g>
        <path className="bv-area" d="M190 140L230 118L270 126L310 96L350 104L390 74L430 82L470 56L490 52V152H190Z" fill={`url(#${g})`} />
        <polyline className="bv-drawl" points="190,140 230,118 270,126 310,96 350,104 390,74 430,82 470,56 490,52" fill="none" stroke="var(--bv-bright)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        <polyline className="bv-drawl" style={{ animationDelay: "0.8s" }} points="190,128 230,134 270,112 310,120 350,92 390,100 430,96 470,84 490,88" fill="none" stroke="#7C3AED" strokeWidth="2" strokeDasharray="4 4" strokeLinejoin="round" opacity="0.8" />
        <path className="bv-chpop" d="M390 36V152" stroke="var(--bv-c1)" strokeWidth="1.5" strokeDasharray="3 4" />
        <circle className="bv-chpop" cx="390" cy="74" r="6" fill="var(--bv-badge-a)" stroke="var(--bv-bright)" strokeWidth="2.5" />
        <g className="bv-chpop" style={{ animationDelay: "0.25s" }}>
          <rect x="402" y="32" width="86" height="34" rx="8" fill="#10243F" />
          <rect x="412" y="41" width="40" height="5" rx="2.5" fill="#BFD7F2" />
          <rect x="412" y="51" width="26" height="5" rx="2.5" fill="#22C55E" />
        </g>
      </g>
      <polyline points="80,150 120,124 150,132" fill="none" stroke="var(--bv-c5)" strokeWidth="1.5" strokeDasharray="3 5" opacity="0.8" />
      <polyline points="520,120 540,80 560,50" fill="none" stroke="var(--bv-c5)" strokeWidth="1.5" strokeDasharray="3 5" opacity="0.8" />
      <g fill="var(--bv-c2)">
        <circle cx="120" cy="124" r="3" />
        <circle cx="540" cy="80" r="3.5" />
      </g>
    </svg>
  );
}

function ImportArt({ uid }: { uid: string }) {
  const f = "pbgi-" + uid;
  return (
    <svg width="560" height="180" viewBox="0 0 560 180">
      <defs>{BLUR(f)}</defs>
      <g filter={`url(#${f})`}>
        <g transform="rotate(-6 200 96)">
          <rect x="140" y="34" width="120" height="124" rx="10" fill="var(--bv-panel)" stroke="var(--bv-c2)" strokeWidth="2" />
          <rect x="156" y="52" width="76" height="6" rx="3" fill="var(--bv-c4)" />
          <rect x="156" y="68" width="88" height="6" rx="3" fill="var(--bv-grid)" />
          <rect x="156" y="84" width="64" height="6" rx="3" fill="var(--bv-grid)" />
          <rect x="156" y="100" width="82" height="6" rx="3" fill="var(--bv-grid)" />
          <rect x="156" y="116" width="58" height="6" rx="3" fill="var(--bv-grid)" />
          <rect className="bv-scan" x="148" y="48" width="104" height="3" rx="1.5" fill="var(--bv-bright)" opacity="0.7" />
        </g>
        <path className="bv-flow" d="M272 96C300 96 304 96 326 96" fill="none" stroke="var(--bv-bright)" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="6 6" />
        <path d="M322 88l10 8-10 8" fill="none" stroke="var(--bv-bright)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="344" y="26" width="166" height="140" rx="14" fill="var(--bv-panel)" stroke="var(--bv-c2)" strokeWidth="2" />
        <g className="bv-row" style={{ animationDelay: "0s" }}>
          <rect x="358" y="42" width="138" height="30" rx="8" fill="var(--bv-inner)" stroke="var(--bv-grid)" strokeWidth="1" />
          <circle cx="374" cy="57" r="8" fill="#22C55E" />
          <path d="M370 57l3 3 5-6" fill="none" stroke="#FFFFFF" strokeWidth="2" />
          <rect x="390" y="53" width="60" height="7" rx="3.5" fill="var(--bv-c2)" />
          <rect x="460" y="53" width="24" height="7" rx="3.5" fill="var(--bv-c5)" />
        </g>
        <g className="bv-row" style={{ animationDelay: "0.5s" }}>
          <rect x="358" y="80" width="138" height="30" rx="8" fill="var(--bv-inner)" stroke="var(--bv-grid)" strokeWidth="1" />
          <circle cx="374" cy="95" r="8" fill="#22C55E" />
          <path d="M370 95l3 3 5-6" fill="none" stroke="#FFFFFF" strokeWidth="2" />
          <rect x="390" y="91" width="48" height="7" rx="3.5" fill="var(--bv-c2)" />
          <rect x="460" y="91" width="24" height="7" rx="3.5" fill="var(--bv-c5)" />
        </g>
        <g className="bv-row" style={{ animationDelay: "1s" }}>
          <rect x="358" y="118" width="138" height="30" rx="8" fill="var(--bv-inner)" stroke="var(--bv-grid)" strokeWidth="1" />
          <circle cx="374" cy="133" r="8" fill="#22C55E" />
          <path d="M370 133l3 3 5-6" fill="none" stroke="#FFFFFF" strokeWidth="2" />
          <rect x="390" y="129" width="66" height="7" rx="3.5" fill="var(--bv-c2)" />
          <rect x="460" y="129" width="24" height="7" rx="3.5" fill="var(--bv-c5)" />
        </g>
      </g>
      <polyline points="60,150 100,126 128,134" fill="none" stroke="var(--bv-c5)" strokeWidth="1.5" strokeDasharray="3 5" opacity="0.8" />
      <polyline points="520,120 540,80 560,50" fill="none" stroke="var(--bv-c5)" strokeWidth="1.5" strokeDasharray="3 5" opacity="0.8" />
      <g fill="var(--bv-c2)">
        <circle cx="100" cy="126" r="3" />
        <circle cx="540" cy="80" r="3.5" />
      </g>
    </svg>
  );
}

export function BannerArt({ variant, uid }: { variant: BannerVariant; uid: string }) {
  switch (variant) {
    case "cappers":
      return <CappersArt uid={uid} />;
    case "picks":
      return <PicksArt uid={uid} />;
    case "parlay":
      return <ParlayArt uid={uid} />;
    case "charts":
      return <ChartsArt uid={uid} />;
    case "import":
      return <ImportArt uid={uid} />;
    case "live":
      return <LiveArt uid={uid} />;
    default:
      return <DashboardArt uid={uid} />;
  }
}
