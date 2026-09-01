// Proof for the M2 getClaims() migration (docs/m2-auth-round-trips.md).
// middleware.ts and server/auth.ts both stopped calling supabase.auth.getUser()
// (a network round-trip to the Auth server on every request, done twice per
// page) and now call supabase.auth.getClaims(), which - because this project
// signs JWTs with an asymmetric ES256 key - verifies the token signature
// LOCALLY via WebCrypto against a cached JWKS.
//
// The only new logic is interpreting the getClaims() result. The real crypto
// path needs a live JWKS + token, so these tests target that interpretation
// (lib/supabase/claims.ts) directly, against the exact result shapes auth-js
// documents:
//   success -> { data: { claims, header, signature }, error: null }
//   failure -> { data: null, error }   (no token / expired `exp` / bad signature)
//
// The load-bearing property: a getClaims() result that is anything other than
// a fully-verified token with a `sub` MUST resolve to "no user" - never a
// half-populated object, never { id: undefined }. If that ever regressed, an
// unverified or expired token could be treated as an authenticated session.
//
// Pure: no react, no next/headers, no prisma, no network. Run with:
//   npx tsx src/lib/supabase/claims-acceptance-test.ts
import { authUserFromClaims, sessionUserFromClaims } from "@/lib/supabase/claims";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!pass) failures++;
}

// Mirrors an auth-js success payload (only the fields the app reads).
const oauthClaims = {
  iss: "https://kbmdydpacvdmbemcwhry.supabase.co/auth/v1",
  sub: "11111111-1111-1111-1111-111111111111",
  aud: "authenticated",
  role: "authenticated",
  exp: 9999999999,
  iat: 1715766000,
  session_id: "22222222-2222-2222-2222-222222222222",
  email: "capper@example.com",
  user_metadata: { full_name: "Test Capper", avatar_url: "https://img/x.png" },
};

function main() {
  // ---- getCurrentUser() path: authUserFromClaims(data?.claims) ----

  // 1. Verified OAuth token -> full identity for the find-or-create.
  check(
    "1: verified OAuth claims -> { id, email, user_metadata }",
    authUserFromClaims(oauthClaims),
    { id: "11111111-1111-1111-1111-111111111111", email: "capper@example.com", user_metadata: { full_name: "Test Capper", avatar_url: "https://img/x.png" } }
  );

  // 2. Email/password user - no user_metadata claim. Still resolves; name/
  //    picture just come through undefined (same as an email signup today).
  check(
    "2: verified claims without user_metadata -> resolves, metadata undefined",
    authUserFromClaims({ sub: "u-2", email: "pw@example.com" }),
    { id: "u-2", email: "pw@example.com", user_metadata: undefined }
  );

  // 3. Claims with no email (phone-only / custom token). Resolves on `sub`;
  //    the caller applies `email ?? ""` when seeding the Prisma row.
  check(
    "3: verified claims without email -> resolves, email undefined",
    authUserFromClaims({ sub: "u-3", user_metadata: {} }),
    { id: "u-3", email: undefined, user_metadata: {} }
  );

  // 4. getClaims() failed (no token / expired `exp` / bad signature) -> it
  //    returns { data: null }. The call site is authUserFromClaims(data?.claims),
  //    so the argument is `undefined`. Must be no user.
  const failedResult: { data: { claims?: unknown } | null; error: unknown } = { data: null, error: new Error("invalid JWT signature") };
  check(
    "4: getClaims failure (data:null) -> authUserFromClaims(undefined) -> null",
    authUserFromClaims(failedResult.data?.claims as Parameters<typeof authUserFromClaims>[0]),
    null
  );
  check("4b: explicit null claims -> null", authUserFromClaims(null), null);

  // 5. Defensive: a claims object with no usable `sub` never yields a
  //    half-populated user.
  check("5: claims without sub -> null", authUserFromClaims({ email: "x@example.com" }), null);
  check("5b: claims with empty-string sub -> null", authUserFromClaims({ sub: "", email: "x@example.com" }), null);

  // ---- middleware path: sessionUserFromClaims(data) ----

  // 6. Verified token -> the id is enough for the redirect decision.
  check(
    "6: verified getClaims result -> { id }",
    sessionUserFromClaims({ claims: oauthClaims, header: { alg: "ES256" }, signature: new Uint8Array() } as never),
    { id: "11111111-1111-1111-1111-111111111111" }
  );

  // 7. getClaims() failed -> data is null -> no session -> middleware redirects.
  check("7: getClaims failure (null) -> null", sessionUserFromClaims(null), null);
  check("7b: getClaims failure (undefined) -> null", sessionUserFromClaims(undefined), null);

  // 8. Defensive: malformed success shapes never produce { id: undefined }.
  check("8: {} -> null", sessionUserFromClaims({}), null);
  check("8b: { claims: null } -> null", sessionUserFromClaims({ claims: null }), null);
  check("8c: { claims: {} } (no sub) -> null", sessionUserFromClaims({ claims: {} }), null);

  // ---- invariants ----

  // The two interpreters agree on identity for a verified token.
  const a = authUserFromClaims(oauthClaims);
  const s = sessionUserFromClaims({ claims: oauthClaims } as never);
  check("invariant: both resolve the same user id for a verified token", a?.id, s?.id);

  // Neither ever fabricates a session from an unverified/absent result. Each
  // entry is [what getClaims returned as `data`, the claims arg the call site
  // derives from it] - i.e. exactly `authUserFromClaims(data?.claims)` and
  // `sessionUserFromClaims(data)`.
  const badResults: { data: unknown; claims: unknown }[] = [
    { data: null, claims: undefined },
    { data: undefined, claims: undefined },
    { data: {}, claims: undefined },
    { data: { claims: null }, claims: null },
    { data: { claims: {} }, claims: {} },
  ];
  const anyFabricated = badResults.some(
    (r) =>
      authUserFromClaims(r.claims as Parameters<typeof authUserFromClaims>[0]) !== null ||
      sessionUserFromClaims(r.data as Parameters<typeof sessionUserFromClaims>[0]) !== null
  );
  check("invariant: no unverified/absent result ever resolves to a user", anyFabricated, false);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
