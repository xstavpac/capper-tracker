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
  log?: BugReportLog;
  insert: (row: {
    id: string;
    userId: string;
    description: string;
    pagePath: string | null;
    userAgent: string | null;
    screenshotPath: string | null;
  }) => Promise<void>;
};

// Where a failure is reported. Optional so callers that don't care (tests) get
// the console; the acceptance test passes a recorder.
export type BugReportLog = { warn: (msg: string) => void; error: (msg: string) => void };

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

// What may be logged about a failed upload: the error's message (capped) and
// its HTTP status, nothing else. Never the key, the file or its bytes, the path
// or the user.
export function describeUploadError(err: unknown): { message: string; status: number | null } {
  const message = err instanceof Error ? err.message : "unknown error";
  const status = (err as { status?: unknown } | null)?.status;
  return { message: message.slice(0, 200), status: typeof status === "number" ? status : null };
}

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

  const log = deps.log ?? console;
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
      } catch (err) {
        // Fall through: the text report is still worth keeping - but say why.
        const { message, status } = describeUploadError(err);
        log.error(`[bug-report] screenshot upload failed: ${message} (status ${status ?? "n/a"})`);
      }
    } else {
      log.warn("[bug-report] screenshot storage is not configured; saved the report without its screenshot");
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
