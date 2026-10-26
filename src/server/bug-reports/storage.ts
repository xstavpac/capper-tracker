import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { BUG_REPORT_BUCKET } from "@/lib/bug-report";

// The ONLY file that reads SUPABASE_SERVICE_ROLE_KEY. Imported by the submit
// action and the admin tab's actions, nothing else (bug-report-acceptance-test
// enforces both, and that no client file reaches it). The key bypasses RLS, so
// it stays server-side and every call here is made on behalf of a gate that has
// already run (requireUser / requireAdminOpsAction).
//
// Until the bucket and the key exist, isScreenshotStorageConfigured() is false
// and a report is saved without its screenshot instead of failing.

export function isScreenshotStorageConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

let client: SupabaseClient | null = null;
function admin(): SupabaseClient {
  if (!isScreenshotStorageConfigured()) throw new Error("Screenshot storage is not configured");
  client ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

export async function uploadScreenshot(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const { error } = await admin().storage.from(BUG_REPORT_BUCKET).upload(path, bytes, { contentType, upsert: false });
  // Carry the HTTP status so submit.ts can log it; the message alone says what, the status says who rejected it.
  if (error) throw Object.assign(new Error(error.message), { status: (error as { status?: number }).status });
}

// Short-lived: the URL is minted on click, so the list page never loads an image.
export async function signScreenshotUrl(path: string, expiresInSeconds = 60): Promise<string> {
  const { data, error } = await admin().storage.from(BUG_REPORT_BUCKET).createSignedUrl(path, expiresInSeconds);
  if (error || !data?.signedUrl) throw new Error(error?.message ?? "Could not sign the screenshot URL");
  return data.signedUrl;
}

export async function removeScreenshot(path: string): Promise<void> {
  const { error } = await admin().storage.from(BUG_REPORT_BUCKET).remove([path]);
  if (error) throw new Error(error.message);
}
