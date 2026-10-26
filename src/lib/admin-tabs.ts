// The /admin ops console's tab row, in display order. A new tab is one entry
// here plus its page under src/app/(app)/admin/ (calling requireAdminOpsPage).
export const ADMIN_TABS = [
  { key: "db-monitor", href: "/admin/db-monitor", label: "DB Monitor" },
  { key: "crons", href: "/admin/crons", label: "Crons" },
  { key: "odds-api", href: "/admin/odds-api", label: "Odds API" },
  { key: "grading", href: "/admin/grading", label: "Grading" },
  { key: "bug-reports", href: "/admin/bug-reports", label: "Bug reports" },
  { key: "imports", href: "/admin/imports", label: "Imports" },
] as const;

export type AdminTabKey = (typeof ADMIN_TABS)[number]["key"];

// Which tabs show the red alert dot, each with the one-line reason shown on
// hover. The admin layout fills this in (getAdminStatus); a tab with no entry
// shows none.
export type AdminTabAlerts = Partial<Record<AdminTabKey, string>>;

export const ADMIN_HOME_HREF: string = ADMIN_TABS[0].href;
