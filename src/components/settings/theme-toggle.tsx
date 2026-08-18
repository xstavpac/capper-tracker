"use client";

import { Theme } from "@prisma/client";
import { useTheme } from "@/components/layout/theme-provider";

export function ThemeToggle() {
  const { theme, setTheme, isSaving } = useTheme();
  const isDark = theme === Theme.DARK;

  return (
    <div className="rounded-card bg-card p-5 shadow-soft">
      <h3 className="mb-3 text-sm font-medium text-card-foreground">Appearance</h3>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-card-foreground">Dark mode</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {isDark ? "Using the dark theme." : "Using the light theme."}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isDark}
          aria-label="Toggle dark mode"
          disabled={isSaving}
          onClick={() => setTheme(isDark ? Theme.LIGHT : Theme.DARK)}
          className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${
            isDark ? "bg-brand-600" : "bg-muted"
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-card shadow-soft transition ${
              isDark ? "left-[22px]" : "left-0.5"
            }`}
          />
        </button>
      </div>
    </div>
  );
}
