// Shared refusal logic for every T2 harness script that touches a Postgres
// connection string - same PROD_MARKERS pattern as scripts/guard-not-prod-db.mjs
// and prisma/seed-dev.ts (the Aug 18 incident class: DATABASE_URL pointed at
// production and an unscoped write ran against it). T2 adds a second layer on
// top of that existing guard: every disposable-DB and anonymize operation in
// this harness calls assertNotProd() on whatever URL it's about to use, so a
// misconfigured env var can't silently point harness code at production, even
// though nothing in this harness is ever *supposed* to hold a prod credential
// in the first place (see extract-from-dump.mjs's header comment for why).
export const PROD_MARKERS = [
  { pattern: "kbmdydpacvdmbemcwhry", why: "production Supabase project ref" },
  { pattern: "pooler.supabase.com", why: "a Supabase connection pooler host" },
];

export function assertNotProd(url, label = "connection string") {
  const hit = PROD_MARKERS.find((m) => url.includes(m.pattern));
  if (hit) {
    throw new Error(
      `[t2-harness] Refusing to use this ${label} - it contains "${hit.pattern}" (${hit.why}). ` +
        `T2 must never hold a live production connection; see extract-from-dump.mjs for the ` +
        `only sanctioned path production data enters this harness.`
    );
  }
}
