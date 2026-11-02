"use server";

// The browser's half of the Parlay Generator's run log (lib/parlay/run-trace.ts).
// Generate-from-a-held-snapshot and Regenerate run the engine in the browser, so
// the browser sends the trace it collected. It is untrusted diagnostics: the user
// comes from the session, the payload is rebuilt from a strict schema
// (sanitizeClientTrace), and a per-user rate limit applies. A rejected or failed
// trace is dropped silently - this action never throws, and the parlay the user
// sees does not depend on it.
import { requireUser } from "@/server/auth";
import { allowTrace, sanitizeClientTrace } from "@/lib/parlay/run-trace-validate";
import { recordGeneratorRun } from "@/server/data/generator-runs";

export async function recordGeneratorRunAction(trace: unknown): Promise<void> {
  try {
    const user = await requireUser();
    if (!allowTrace(user.id)) return;
    const clean = sanitizeClientTrace(trace);
    if (clean) await recordGeneratorRun(user.id, clean);
  } catch (err) {
    console.error("[generator-runs] client trace dropped", err instanceof Error ? err.message : String(err));
  }
}
