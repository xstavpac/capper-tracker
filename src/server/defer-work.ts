import { waitUntil } from "@vercel/functions";

// Keeps a promise's work alive after the response is sent: on Vercel an un-awaited promise can be killed once the
// response returns. Outside a Vercel request (tests, local dev) there is no context and the promise just runs.
// The promise must never reject into the caller - a rejection is swallowed here.
export function deferToPlatform(work: Promise<unknown>): void {
  work.catch(() => {});
  try {
    waitUntil(work);
  } catch {
    // no request context: nothing to register with
  }
}
