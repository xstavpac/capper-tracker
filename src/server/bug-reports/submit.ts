import {
  buildScreenshotPath,
  cleanPagePath,
  cleanUserAgent,
  decideBugReportRate,
  RATE_LIMIT_WINDOW_MS,
  validateDescription,
  validateScreenshot,
  type ScreenshotType,
} from "@/lib/bug-report";

// The submit flow with its I/O injected, so the acceptance test can drive every
// branch (rate limit, bad file, no bucket yet, upload failure) with fakes and
// no database or Supabase. The server action wires the real ones.

export type BugReportDeps = {
  now: () => Date;
  newId: () => string;
  // This user's report count since `since`, and their newest report's time.
  recentActivity: (userId: string, since: Date) => Promise<{ count: number; latestAt: Date | null }>;
  storageConfigured: () => boolean;
  upload: (path: string, bytes: Uint8Array, contentType: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  insert: (row: {
    id: string;
    userId: string;
    description: string;
    pagePath: string | null;
    userAgent: string | null;
    screenshotPath: string | null;
  }) => Promise<void>;
};

export type BugReportInput = {
  userId: string;
  description: unknown;
  pagePath: unknown;
  userAgent: unknown;
  screenshot: Uint8Array | null; // already read from the form's File, null if none attached
};

// "saved": screenshot stored. "none": the user attached none.
// "unavailable": they attached one but it could not be stored (no bucket/key
// yet, or the upload failed) - the text report was still saved.
export type BugReportResult =
  | { ok: true; screenshot: "saved" | "none" | "unavailable" }
  | { ok: false; error: string };

export async function submitBugReport(deps: BugReportDeps, input: BugReportInput): Promise<BugReportResult> {
  const description = validateDescription(input.description);
  if (!description.ok) return description;

  let type: ScreenshotType | null = null;
  if (input.screenshot) {
    const v = validateScreenshot(input.screenshot);
    if (!v.ok) return v;
    type = v.value;
  }

  const now = deps.now();
  const recent = await deps.recentActivity(input.userId, new Date(now.getTime() - RATE_LIMIT_WINDOW_MS));
  const rate = decideBugReportRate({ countInWindow: recent.count, latestAt: recent.latestAt, now });
  if (!rate.ok) return rate;

  const id = deps.newId();
  let screenshotPath: string | null = null;
  let screenshot: "saved" | "none" | "unavailable" = "none";

  if (input.screenshot && type) {
    screenshot = "unavailable";
    if (deps.storageConfigured()) {
      const path = buildScreenshotPath(input.userId, id, type.ext);
      try {
        await deps.upload(path, input.screenshot, type.mime);
        screenshotPath = path;
        screenshot = "saved";
      } catch {
        // Fall through: the text report is still worth keeping.
      }
    }
  }

  try {
    await deps.insert({
      id,
      userId: input.userId,
      description: description.value,
      pagePath: cleanPagePath(input.pagePath),
      userAgent: cleanUserAgent(input.userAgent),
      screenshotPath,
    });
  } catch {
    // Don't leave an orphan object behind a row that never landed.
    if (screenshotPath) await deps.remove(screenshotPath).catch(() => {});
    return { ok: false, error: "Could not save your report. Please try again." };
  }
  return { ok: true, screenshot };
}
