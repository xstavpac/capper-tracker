// Pure rules for Settings > Report a bug: what a report may contain and how
// often a user may send one. No I/O, so the browser form, the submit action
// and the acceptance test all share the same limits.

export const BUG_REPORT_BUCKET = "bug-reports";

export const MAX_DESCRIPTION_CHARS = 2000;
export const MAX_PAGE_PATH_CHARS = 200;
export const MAX_USER_AGENT_CHARS = 300;

// The browser shrinks the screenshot to fit under this; the server enforces it
// again. Below the 1 MB server-action body limit, so no next.config change.
export const MAX_SCREENSHOT_BYTES = 500 * 1024;
export const SCREENSHOT_MAX_EDGE_PX = 1600;

export const RATE_LIMIT_PER_DAY = 5;
export const RATE_LIMIT_MIN_GAP_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const RATE_LIMIT_WINDOW_MS = DAY_MS;

export type ScreenshotType = { mime: "image/png" | "image/jpeg" | "image/webp"; ext: "png" | "jpg" | "webp" };

// The type comes from the file's own first bytes, never the client's filename
// or declared MIME. SVG (and anything else) is rejected by falling through.
export function sniffScreenshotType(bytes: Uint8Array): ScreenshotType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { mime: "image/png", ext: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  // RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateDescription(raw: unknown): Validated<string> {
  if (typeof raw !== "string") return { ok: false, error: "Please describe the problem." };
  const text = raw.trim();
  if (text.length === 0) return { ok: false, error: "Please describe the problem." };
  if (text.length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, error: `Please keep the description under ${MAX_DESCRIPTION_CHARS} characters.` };
  }
  return { ok: true, value: text };
}

// The page the user was on: a same-origin path only (leading "/", not "//"),
// never a full URL. Anything else is dropped, not an error - it is context, not
// something worth refusing the report over.
export function cleanPagePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.trim();
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  return path.length > MAX_PAGE_PATH_CHARS ? path.slice(0, MAX_PAGE_PATH_CHARS) : path;
}

export function cleanUserAgent(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const ua = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return ua ? ua.slice(0, MAX_USER_AGENT_CHARS) : null;
}

export function validateScreenshot(bytes: Uint8Array): Validated<ScreenshotType> {
  if (bytes.length === 0) return { ok: false, error: "That screenshot is empty." };
  if (bytes.length > MAX_SCREENSHOT_BYTES) {
    return { ok: false, error: "That screenshot is too large (500 KB maximum after shrinking)." };
  }
  const type = sniffScreenshotType(bytes);
  if (!type) return { ok: false, error: "Screenshots must be PNG, JPEG or WebP images." };
  return { ok: true, value: type };
}

// Server-chosen object path. The client's filename never reaches storage.
// userId and reportId are our own cuid/uuid values; the segment check keeps a
// malformed one from ever becoming a path traversal.
export function buildScreenshotPath(userId: string, reportId: string, ext: ScreenshotType["ext"]): string {
  for (const seg of [userId, reportId]) {
    if (!/^[A-Za-z0-9_-]+$/.test(seg)) throw new Error("Unsafe storage path segment");
  }
  return `${userId}/${reportId}.${ext}`;
}

export type RateDecision = { ok: true } | { ok: false; error: string };

// countInWindow = this user's reports in the last RATE_LIMIT_WINDOW_MS;
// latestAt = their most recent report's createdAt. Counted from the database
// (not the in-memory limiter) because that limiter is per serverless instance
// and can't hold a storage-filling user to a real daily cap.
export function decideBugReportRate(input: { countInWindow: number; latestAt: Date | null; now: Date }): RateDecision {
  const { countInWindow, latestAt, now } = input;
  if (latestAt && now.getTime() - latestAt.getTime() < RATE_LIMIT_MIN_GAP_MS) {
    return { ok: false, error: "Please wait a minute before sending another report." };
  }
  if (countInWindow >= RATE_LIMIT_PER_DAY) {
    return { ok: false, error: `You've reached today's limit of ${RATE_LIMIT_PER_DAY} reports. Please try again tomorrow.` };
  }
  return { ok: true };
}
