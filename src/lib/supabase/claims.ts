// Pure interpreters for a `supabase.auth.getClaims()` result. Split into their
// own module (no react, no next/headers, no Supabase client construction) so
// the M2 getClaims() wiring - see docs/m2-auth-round-trips.md - is unit-testable
// without a live Supabase token, the Edge runtime, or the React cache()
// wrapper around getCurrentUser().
//
// getClaims() returns `{ data: { claims, header, signature }, error: null }` on
// success and `{ data: null, error }` whenever it could NOT establish trusted
// claims: no access token in the cookies, an `exp` already in the past, or a
// signature that fails verification against the project's JWKS. Every one of
// those must resolve to "no user" here - never a half-populated object, never
// `{ id: undefined }`.

export type AuthUser = { id: string; email?: string; user_metadata?: Record<string, unknown> };

type ClaimsShape = { sub?: string; email?: string; user_metadata?: Record<string, unknown> } | null | undefined;

// For getCurrentUser() (server/auth.ts): the identity the find-or-create of
// the Prisma User row consumes. `email` / `user_metadata` are only read on a
// first-ever sign-in, when the JWT was just minted, so they are never stale in
// practice.
export function authUserFromClaims(claims: ClaimsShape): AuthUser | null {
  return claims?.sub ? { id: claims.sub, email: claims.email, user_metadata: claims.user_metadata } : null;
}

// For updateSupabaseSession() (lib/supabase/middleware.ts): the middleware only
// needs "is there a valid session" to decide the /sign-in redirect, so the id
// alone is enough.
export function sessionUserFromClaims(data: { claims?: ClaimsShape } | null | undefined): { id: string } | null {
  const sub = data?.claims?.sub;
  return sub ? { id: sub } : null;
}
