import { getRecordColor, type CategoryBreakdownItem, type PickCategoryKey } from "@/server/data/stats";

// The short mark in a tile's icon square. Period-scoped markets (F5, a half, a quarter, a hockey
// period) show their period: the tile's label already names the side.
const GLYPHS: Partial<Record<PickCategoryKey, string>> = {
  FAV_ML: "FAV",
  DOG_ML: "DOG",
  SPREAD_MINUS: "−7",
  SPREAD_PLUS: "+7",
  SPREAD: "±",
  OVER: "O",
  UNDER: "U",
  TD_PROP: "PRP",
  NRFI: "NR",
  YRFI: "YR",
  TEAM_TOTAL: "TT",
};
const PERIOD_GLYPHS: [prefix: string, glyph: string][] = [
  ["F5_", "F5"],
  ["FIRST_HALF_", "1H"],
  ["SECOND_HALF_", "2H"],
  ["FIRST_QUARTER_", "Q1"],
  ["SECOND_QUARTER_", "Q2"],
  ["THIRD_QUARTER_", "Q3"],
  ["FOURTH_QUARTER_", "Q4"],
  ["FIRST_PERIOD_", "P1"],
  ["SECOND_PERIOD_", "P2"],
  ["THIRD_PERIOD_", "P3"],
];

function marketGlyph(key: PickCategoryKey): string {
  return GLYPHS[key] ?? PERIOD_GLYPHS.find(([prefix]) => key.startsWith(prefix))?.[1] ?? "•";
}

// The app's one win/loss rule (getRecordColor: green at 50% and up, red below), as this tile's
// wash, border, ink and bar. A market with no win or loss yet (pushes only) has no win % to
// color: the neutral surface and a dash, never a red "0%" (as category-card.tsx).
const TONES = {
  green: {
    card: "border-[#A7F3D0] bg-[#ECFDF5] dark:border-emerald-500/45 dark:bg-emerald-500/10",
    ink: "text-[#047857] dark:text-emerald-300",
    icon: "border-[#A7F3D0] dark:border-emerald-500/45",
    bar: "bg-[#10B981]",
  },
  red: {
    card: "border-[#FECACA] bg-[#FEF2F2] dark:border-red-500/45 dark:bg-red-500/10",
    ink: "text-[#B91C1C] dark:text-red-300",
    icon: "border-[#FECACA] dark:border-red-500/45",
    bar: "bg-[#EF4444]",
  },
  neutral: {
    card: "border-[#E2E8F0] bg-[#F8FAFC] dark:border-border dark:bg-white/[0.04]",
    ink: "text-[#334155] dark:text-foreground",
    icon: "border-[#E2E8F0] dark:border-border",
    bar: "bg-[#64748B]",
  },
};

export function MarketTile({ item }: { item: CategoryBreakdownItem }) {
  const decided = item.wins + item.losses > 0;
  const tone = TONES[decided ? getRecordColor(item.winPct) : "neutral"];
  return (
    <div className={"flex flex-col gap-3.5 rounded-[18px] border p-[18px] " + tone.card}>
      <div className="flex min-w-0 items-center gap-3">
        <span className={"flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[10px] border bg-white font-mono text-[11px] font-bold dark:bg-white/5 " + tone.icon + " " + tone.ink}>
          {marketGlyph(item.key)}
        </span>
        <span className="min-w-0 truncate text-[15px] font-extrabold text-foreground">{item.label}</span>
      </div>
      <div className="flex items-end justify-between gap-3">
        <span className={"text-[40px] font-extrabold leading-none tabular-nums " + tone.ink}>
          {decided ? (
            Math.round(item.winPct) + "%"
          ) : (
            <>
              <span aria-hidden>—</span>
              <span className="sr-only">No win rate yet</span>
            </>
          )}
        </span>
        <span className="text-right">
          <span className="block text-lg font-extrabold leading-tight tabular-nums text-foreground">
            {item.wins}-{item.losses}
            {item.pushes > 0 ? "-" + item.pushes : ""}
          </span>
          <span className="block text-xs tabular-nums text-[#64748B] dark:text-muted-foreground">{item.count} graded</span>
        </span>
      </div>
      <div aria-hidden className="relative h-2 overflow-hidden rounded-full bg-[#0F1420]/[0.08] dark:bg-white/10">
        {decided && <div className={"h-full rounded-full " + tone.bar} style={{ width: Math.min(100, Math.max(0, item.winPct)) + "%" }} />}
        <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-[#0F172A]/70 dark:bg-white/70" />
      </div>
    </div>
  );
}
