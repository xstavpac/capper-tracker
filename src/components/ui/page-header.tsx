import type { ReactNode } from "react";

type PageHeaderProps = {
  // Inline SVG shown in the rounded tile - sized by the tile, so pass a bare <svg className="h-6 w-6">.
  icon: ReactNode;
  title: string;
  subtitle?: string;
  back?: { href: string; label: string };
  // Right-aligned on desktop; wraps under the title on narrow screens.
  action?: ReactNode;
};

// Deep-navy page header with an icon tile and a real <h1> - the text-based
// replacement for ImageBanner (whose title is baked into the image).
export function PageHeader({ icon, title, subtitle, back, action }: PageHeaderProps) {
  return (
    <header className="relative mb-5 overflow-hidden rounded-card bg-gradient-to-br from-slate-950 via-slate-900 to-brand-900 px-5 py-4 text-white shadow-soft sm:px-6 sm:py-5">
      <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-28 h-72 w-72 rounded-full bg-brand-500/40 blur-3xl" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-32 left-1/3 h-56 w-56 rounded-full bg-brand-400/15 blur-3xl" />
      <div className="relative flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-500/20 text-brand-200 ring-1 ring-inset ring-brand-400/40">
          {icon}
        </div>
        <div className="min-w-0 flex-1 basis-64">
          {back && (
            <a
              href={back.href}
              className="-my-2 inline-flex min-h-[44px] items-center text-sm font-medium text-brand-200 transition hover:text-white"
            >
              <span aria-hidden="true" className="mr-1">
                &larr;
              </span>
              {back.label}
            </a>
          )}
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 max-w-2xl text-sm text-slate-200">{subtitle}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </header>
  );
}

// Outline button for PageHeader's `action` slot, sized for touch.
export const pageHeaderActionClass =
  "inline-flex min-h-[44px] items-center justify-center rounded-full border border-white/40 px-5 text-sm font-medium text-white transition hover:border-white/70 hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300";
