// Auth boundary of GET /api/live/scores, which now checks the session with
// requireSession() (verified claims, no users-row read) instead of requireUser().
// A request with no session, an invalid session or an expired session is
// rejected with the same 401 as before; a valid one gets the same
// { scores } body. getClaims is stubbed to the contract claims.ts documents
// (any failure to establish trusted claims comes back as { data: null, error });
// the signature check itself is Supabase's, not re-tested here.
// Run: npx tsx src/server/live-scores-response-acceptance-test.ts
// Exits non-zero if any assertion fails.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { requireSession, resolveAuthUser, type GetClaims } from "./auth-session";
import { liveScoresResponse } from "./live-scores-response";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`${pass ? "PASS" : "FAIL"}: ${label}${detail ? "  " + detail : ""}`);
  if (!pass) failures++;
}

const rejects = async (p: Promise<unknown>) =>
  p.then(
    () => false,
    () => true
  );
const asClaims = (v: unknown) => (async () => v) as GetClaims;

async function main() {
  // --- requireSession ---
  const noSession = asClaims({ data: null, error: { message: "Auth session missing" } });
  const invalid = asClaims({ data: null, error: { message: "invalid JWT signature" } });
  const expired = asClaims({ data: null, error: { message: "JWT expired" } });
  const claimsWithoutSub = asClaims({ data: { claims: { email: "a@b.test" } } });
  const throwing: GetClaims = async () => {
    throw new Error("Supabase URL and key are required");
  };
  const valid = asClaims({ data: { claims: { sub: "sb-user-1", email: "a@b.test", user_metadata: { full_name: "A B" } } } });

  const origError = console.error;
  console.error = () => {};
  check("no session is rejected", await rejects(requireSession(noSession)));
  check("invalid session is rejected", await rejects(requireSession(invalid)));
  check("expired session is rejected", await rejects(requireSession(expired)));
  check("claims without a subject are rejected", await rejects(requireSession(claimsWithoutSub)));
  check("a failing Supabase client is rejected, not thrown past the guard", await rejects(requireSession(throwing)));
  check("resolveAuthUser returns null (no throw) for a failing client", (await resolveAuthUser(throwing)) === null);
  console.error = origError;

  const who = await requireSession(valid);
  check("valid session resolves the verified identity", who.id === "sb-user-1" && who.email === "a@b.test");

  // Nothing is remembered between calls or between users: two different
  // sessions through the same module resolve to their own ids, and a session
  // that has gone away is rejected on the very next call.
  const a = await requireSession(asClaims({ data: { claims: { sub: "user-a" } } }));
  const b = await requireSession(asClaims({ data: { claims: { sub: "user-b" } } }));
  check("two users resolve independently", a.id === "user-a" && b.id === "user-b");
  check("a session that ended is rejected on the next call", await rejects(requireSession(noSession)));

  // --- the route body ---
  const scores = [{ id: "g1", status: "live" }];
  let scoreCalls = 0;
  const getScores = async (sport: string) => {
    scoreCalls++;
    return sport === "baseball_mlb" ? scores : [];
  };
  const ok = { requireSession: async () => ({ id: "x" }), getScores };
  const denied = {
    requireSession: async () => {
      throw new Error("Not authenticated");
    },
    getScores,
  };
  const url = (q: string) => new Request("http://localhost/api/live/scores" + q);

  const rDenied = await liveScoresResponse(url("?sport=baseball_mlb"), denied);
  check("unauthenticated request gets 401 Unauthorized (unchanged)", rDenied.status === 401 && (await rDenied.text()) === "Unauthorized");
  check("an unauthenticated request never reads scores", scoreCalls === 0);

  const rOk = await liveScoresResponse(url("?sport=baseball_mlb"), ok);
  const body = await rOk.json();
  check("valid request gets 200 and { scores } (unchanged shape)", rOk.status === 200 && JSON.stringify(body) === JSON.stringify({ scores }));

  const rMissing = await liveScoresResponse(url(""), ok);
  check("missing sport is still a 400 with error 'missing sport'", rMissing.status === 400 && (await rMissing.json()).error === "missing sport");

  // --- wiring guards (source text) ---
  const src = join(__dirname, "..");
  const routeSrc = readFileSync(join(src, "app/api/live/scores/route.ts"), "utf8");
  check("the scores route uses requireSession", /requireSession/.test(routeSrc) && !/requireUser|getCurrentUser/.test(routeSrc));

  const users: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry) && !/-test\.ts$/.test(entry) && /^import[^;]*\brequireSession\b[^;]*;/m.test(readFileSync(full, "utf8"))) {
        users.push(full.slice(src.length + 1).replace(/\\/g, "/"));
      }
    }
  };
  walk(src);
  const expected = ["app/api/live/scores/route.ts"];
  check("requireSession is imported by no other file", JSON.stringify(users.sort()) === JSON.stringify(expected), users.join(", "));

  const sessionSrc = readFileSync(join(src, "server/auth-session.ts"), "utf8");
  check("auth-session reads no database", !/prisma/.test(sessionSrc));
  check("auth-session has no cross-request cache", !/unstable_cache|cachedByTag|memoizeWithTtl|from "react"/.test(sessionSrc));

  if (failures > 0) {
    console.log(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll assertions passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
