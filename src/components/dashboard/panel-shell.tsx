import type { ReactNode } from "react";

// The tinted panel card shared by /cappers and /dashboard: header (icon tile, title, optional control),
// subtitle, body, footer. Plus the row pieces every panel lines up on.

export const GREEN = "text-[#15803D] dark:text-emerald-400";
export const RED = "text-[#B91C1C] dark:text-red-400";

// A hue: a soft card tint + border, the header's icon tile, the subtitle's dark shade, the control's
// border, and the footer's icon + link color. Dark mode keeps a faint wash of the hue.
export type PanelTint = { card: string; iconWrap: string; subtitleClass: string; control: string; accent: string };
export type PanelTheme = PanelTint & { title: string; subtitle: string; icon: ReactNode };

export const TINTS = {
  blue: {
    card: "bg-[#F6F8FF] border-[#E1E7FA] dark:bg-brand-500/[0.06] dark:border-brand-500/30",
    iconWrap: "rounded-full bg-[#E6ECFF] text-brand-600 dark:bg-brand-500/15 dark:text-brand-400",
    subtitleClass: "text-[#5B6275] dark:text-muted-foreground",
    control: "border-[#DADDE5] dark:border-border",
    accent: "text-brand-600 dark:text-brand-400",
  },
  green: {
    card: "bg-[#F4FBF7] border-[#D6EFDF] dark:bg-emerald-500/[0.06] dark:border-emerald-500/30",
    iconWrap: "rounded-full bg-[#DCF7E6] text-[#16A34A] dark:bg-emerald-500/15 dark:text-emerald-400",
    subtitleClass: "text-[#5B6275] dark:text-muted-foreground",
    control: "border-[#DADDE5] dark:border-border",
    accent: GREEN,
  },
  orange: {
    card: "bg-[#FFF8F2] border-[#F8E1CC] dark:bg-orange-500/[0.06] dark:border-orange-500/30",
    iconWrap: "rounded-full bg-[#FFE3CC] dark:bg-orange-500/15",
    subtitleClass: "text-[#6B4A2E] dark:text-muted-foreground",
    control: "border-[#F1D3B6] dark:border-border",
    accent: "text-[#C2410C] dark:text-orange-400",
  },
  violet: {
    card: "bg-[#FAF7FF] border-[#E7DDFA] dark:bg-violet-500/[0.06] dark:border-violet-500/30",
    iconWrap: "rounded-full bg-[#EDE2FF] text-[#7C3AED] dark:bg-violet-500/15 dark:text-violet-400",
    subtitleClass: "text-[#5B4E75] dark:text-muted-foreground",
    control: "border-[#E2D4FB] dark:border-border",
    accent: "text-[#6D28D9] dark:text-violet-400",
  },
  red: {
    card: "bg-[#FFF7F7] border-[#F6D9D9] dark:bg-red-500/[0.06] dark:border-red-500/30",
    iconWrap: "rounded-full bg-[#FFE0E0] text-[#DC2626] dark:bg-red-500/15 dark:text-red-400",
    subtitleClass: "text-[#7A3A3A] dark:text-muted-foreground",
    control: "border-[#F3CACA] dark:border-border",
    accent: RED,
  },
  rose: {
    card: "bg-[#FFF5F8] border-[#F8D7E1] dark:bg-rose-500/[0.06] dark:border-rose-500/30",
    iconWrap: "rounded-full bg-[#FFDDE7] text-[#E11D48] dark:bg-rose-500/15 dark:text-rose-400",
    subtitleClass: "text-[#7A3A4A] dark:text-muted-foreground",
    control: "border-[#F3CAD6] dark:border-border",
    accent: "text-[#BE123C] dark:text-rose-400",
  },
  // No hue: the plain white card (the stat cards' surface) for panels that are not about one mood.
  neutral: {
    card: "border-transparent bg-white shadow-[0_1px_2px_rgba(15,20,32,0.05),0_6px_18px_rgba(15,20,32,0.04)] dark:border-border dark:bg-card dark:shadow-none",
    iconWrap: "rounded-full bg-[#E6ECFF] text-brand-600 dark:bg-brand-500/15 dark:text-brand-400",
    subtitleClass: "text-[#5B6275] dark:text-muted-foreground",
    control: "border-[#DADDE5] dark:border-border",
    accent: "text-brand-600 dark:text-brand-400",
  },
} satisfies Record<string, PanelTint>;

// Every panel's rank column is this wide (the Biggest Winners medal too), so names start on the same
// line across a row of panels.
export function Rank({ n }: { n: number }) {
  return <span className="w-5 shrink-0 text-[13px] font-semibold tabular-nums text-foreground">{n + "."}</span>;
}
export function Name({ children }: { children: ReactNode }) {
  return <span className="block truncate text-sm font-semibold text-foreground">{children}</span>;
}

// The gap closes to 6px in the three-column range where the sidebar leaves each panel at its narrowest.
export const ROW = "flex h-9 items-center gap-2.5 rounded-[10px] px-1.5 transition-colors hover:bg-foreground/[0.035] min-[1500px]:max-[1699px]:gap-1.5";
export const FOOTER_TEXT = "min-w-0 flex-1 truncate text-xs font-medium text-[#3A4152] dark:text-foreground/75";
export const FOOTER_LINK = "shrink-0 whitespace-nowrap text-xs font-semibold hover:underline";
export const STRONG = "font-semibold text-foreground";

// A footer sentence that opens with a capper's name: the name truncates, the rest (the stat) never does.
export function FooterLine({ name, children }: { name: string; children: ReactNode }) {
  return (
    <p className="flex min-w-0 flex-1 overflow-hidden text-xs font-medium text-[#3A4152] dark:text-foreground/75">
      <span className={"min-w-0 truncate " + STRONG}>{name}</span>
      <span className="shrink-0 whitespace-pre"> {children}</span>
    </p>
  );
}

export function PanelShell({ theme: t, control, footer, busy, children }: { theme: PanelTheme; control?: ReactNode; footer: ReactNode; busy?: boolean; children: ReactNode }) {
  return (
    <section className={"flex h-full flex-col rounded-[18px] border p-3.5 " + t.card}>
      <div className="flex items-center gap-3">
        <span className={"flex h-[26px] w-[26px] shrink-0 items-center justify-center " + t.iconWrap}>{t.icon}</span>
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">{t.title}</h2>
        {control}
      </div>
      {/* Under the whole header row, so it never has to share a line with the control. */}
      <p className={"-mt-px truncate pl-[38px] text-xs font-medium leading-4 " + t.subtitleClass}>{t.subtitle}</p>
      <div className="mt-2.5 flex flex-1 flex-col">{children}</div>
      {footer && <div className={"mt-2 flex h-10 items-center gap-2.5 border-t border-[#0F1420]/[0.08] px-0.5 transition-opacity dark:border-white/10 " + (busy ? "opacity-60" : "")}>{footer}</div>}
    </section>
  );
}

// The header's control: a window dropdown, or a chip saying what a windowless panel reads.
export const CONTROL = "rounded-[9px] border bg-white text-xs font-medium text-foreground dark:bg-card";

export function Message({ children, error }: { children: ReactNode; error?: boolean }) {
  return <p className={"flex flex-1 items-center justify-center py-6 text-center text-[13px] font-medium " + (error ? RED : "text-muted-foreground")}>{children}</p>;
}
