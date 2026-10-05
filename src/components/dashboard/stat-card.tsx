import type { ReactNode } from "react";

// The white stat card shared by /cappers and /dashboard: icon circle, label, value, a sub line and
// (where the number has a history) a sparkline.

export const GREEN = "text-[#15803D] dark:text-emerald-400";
export const RED = "text-[#B91C1C] dark:text-red-400";
export const MUTED = "text-[#5B6275] dark:text-muted-foreground";

export const signed = (n: number, suffix = "") => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toLocaleString("en-US") + suffix;
// "↑ +12 this month" / "↓ −3 this week": arrow and color follow the sign; 0 is neutral.
export const delta = (n: number, text: string) => ({ sub: (n > 0 ? "↑ +" : n < 0 ? "↓ −" : "") + text, subClass: n > 0 ? GREEN : n < 0 ? RED : MUTED });

// The card's trend: one point per week, oldest first, scaled to its own range, with a soft fill.
function Spark({ values, color }: { values: number[]; color: string }) {
  const W = 64;
  const H = 34;
  const pad = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = W / (values.length - 1);
  const pts = values.map((v, i) => (i * step).toFixed(1) + "," + (max === min ? H / 2 : pad + (H - pad * 2) * (1 - (v - min) / span)).toFixed(1)).join(" ");
  return (
    <svg viewBox={"0 0 " + W + " " + H} preserveAspectRatio="none" className="h-[34px] w-16 min-w-0 shrink" aria-hidden>
      <polygon points={pts + " " + W + "," + H + " 0," + H} fill={color} fillOpacity={0.07} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function StatCard({
  label,
  icon,
  iconClass,
  color,
  value,
  valueClass,
  sub,
  subClass,
  series,
  className,
  href,
}: {
  label: string;
  icon: ReactNode;
  iconClass: string;
  // The sparkline's color.
  color: string;
  value: string;
  valueClass?: string;
  sub: ReactNode;
  subClass?: string;
  // Omitted when the number has no history to draw: the card then has no sparkline.
  series?: number[];
  className?: string;
  // Makes the whole card a link.
  href?: string;
}) {
  const card = "flex items-center gap-3 rounded-2xl bg-white px-4 py-[13px] shadow-[0_1px_2px_rgba(15,20,32,0.05),0_6px_18px_rgba(15,20,32,0.04)] dark:border dark:border-border dark:bg-card dark:shadow-none min-[1700px]:gap-3.5 " + (className ?? "");
  const body = (
    <>
      <span className={"flex h-10 w-10 shrink-0 items-center justify-center rounded-full " + iconClass}>{icon}</span>
      <div className="min-w-0 flex-1">
        <p className={"truncate text-[10.5px] font-semibold uppercase tracking-[0.07em] " + MUTED}>{label}</p>
        {/* The sparkline shares the value's row, so it gives way before the number does in a narrow card.
            A value still too long for the row then shrinks to fit it: the row is a size container and
            the font follows its width over the value's length (a tabular character is ~0.62em wide),
            from 22px down to an 18px floor. Past the floor it wraps (it never shrinks below its own width
            first, so the sparkline has fully given way by then) rather than overflow or clip. */}
        <div className="mt-0.5 flex items-center justify-between gap-2 [container-type:inline-size]">
          <p
            className={"max-w-full shrink-0 font-semibold leading-[1.15] tracking-[-0.02em] tabular-nums [overflow-wrap:anywhere] " + (valueClass ?? "text-foreground")}
            style={{ fontSize: "clamp(18px, calc(100cqw / " + (Math.max(1, value.length) * 0.62).toFixed(2) + "), 22px)" }}
          >
            {value}
          </p>
          {series && series.length > 1 && <Spark values={series} color={color} />}
        </div>
        <p className={"mt-0.5 text-[11.5px] font-medium leading-tight tabular-nums " + (subClass ?? MUTED)}>{sub}</p>
      </div>
    </>
  );
  return href ? (
    <a href={href} className={card + " transition hover:brightness-[0.98] dark:hover:brightness-110"}>
      {body}
    </a>
  ) : (
    <div className={card}>{body}</div>
  );
}
