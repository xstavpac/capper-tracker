"use client";

import { createContext, useCallback, useContext, useState, useTransition } from "react";
import { Theme } from "@prisma/client";
import { updateThemePreferenceAction } from "@/server/actions/settings";

type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  isSaving: boolean;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

// Carries the `dark` class on a div wrapping the authenticated-app subtree
// (not <html>) - only the root layout can render <html> in the App Router,
// and putting the class there would require reading auth/cookies in the
// root layout, which wraps marketing/auth pages too and would force those
// currently-static pages into dynamic rendering for a feature they don't
// use. Tailwind's `dark:` selector strategy just needs a `.dark` ancestor,
// not specifically <html>, so scoping it to AppLayout's wrapper costs
// marketing pages nothing.
export function ThemeProvider({ initialTheme, children }: { initialTheme: Theme; children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const [isSaving, startTransition] = useTransition();

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    startTransition(async () => {
      await updateThemePreferenceAction(next);
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, isSaving }}>
      {/* text-foreground here (not just the `dark` class) is load-bearing: <body>
          in the root layout sets text-foreground too, but it sits outside this
          `.dark` scope, so its computed color is always the light value and
          that's what every descendant with no color class of its own inherits -
          re-declaring it here restarts inheritance at the correct (possibly
          dark-scoped) value for the whole app subtree. */}
      <div className={(theme === Theme.DARK ? "dark " : "") + "text-foreground"}>{children}</div>
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
