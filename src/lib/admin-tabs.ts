// The /admin ops console's tab row, in display order. A new tab is one entry
// here plus its page under src/app/(app)/admin/ (calling requireAdminOpsPage).
export const ADMIN_TABS = [
  { key: "db-monitor", href: "/admin/db-monitor", label: "DB Monitor" },
  { key: "skipped-lines", href: "/admin/import-skipped-lines", label: "Skipped Lines" },
] as const;

export type AdminTabKey = (typeof ADMIN_TABS)[number]["key"];

// Which tabs show the red alert dot. The admin layout fills this in; a tab
// with no entry (or false) shows none.
export type AdminTabAlerts = Partial<Record<AdminTabKey, boolean>>;

export const ADMIN_HOME_HREF: string = ADMIN_TABS[0].href;
