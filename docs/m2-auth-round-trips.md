# M2 — auth double network round-trip

**Status (2026-09-01):** Fixed. `middleware.ts` and `getCurrentUser()` now call
`supabase.auth.getClaims()` (local signature verification) instead of
`supabase.auth.getUser()` (a network call to the Supabase Auth server on every
request, which ran twice per authenticated request). Supersedes the M2 line in
`scale-readiness-followups.md`.

**Deferred, explicitly not part of this change:** lowering the Supabase JWT
expiry (currently the default 3600 s). That is a separate production
security-policy decision — refresh frequency, mobile / backgrounded-tab
behavior, any other clients on this Supabase project — to be evaluated once the
`getClaims()` change has been running and observed, not bundled here.

**Epistemic tags:** Verified (repo / current Supabase docs / the project's own
public JWKS endpoint), [ESTIMATE] (modeled, not measured).

---

## 1. The problem

- `src/lib/supabase/middleware.ts` (`updateSupabaseSession`, run on **every**
  request by `middleware.ts`, Edge runtime) called `supabase.auth.getUser()`.
- `src/server/auth.ts` (`getCurrentUser`, `cache()`-wrapped, called by every
  `(app)/*` page, every `server/actions/*`, `/api/live/scores`,
  `/api/public/live-scores`, the marketing page) called `supabase.auth.getUser()`.
- **Verified:** `auth.getUser()` in `@supabase/auth-js` 2.112.2 always issues
  `GET https://<project>.supabase.co/auth/v1/user` when a session exists
  (`GoTrueClient._getUser`, no local branch).
- The two calls are **not deduped by anything**: middleware runs in a separate
  Edge invocation that completes before the request reaches the route; the RSC
  render runs later in Node. React `cache()` only dedupes within one RSC render
  (it collapses `(app)/layout.tsx`'s `requireUser()` and the page's
  `requireUser()` into one call — but cannot see the middleware call).

So every authenticated request = **2 serial round-trips to Supabase Auth**
before any application code runs. The `/live` page's `/api/live/scores` poll
(every 25 s per open tab) pays this twice per poll.

**[ESTIMATE] scale cost:** at 50k users with ~5k concurrent `/live` tabs, the
poll path alone is ~5000 × (60/25) × 2 ≈ **24,000 Auth requests/min (~400/s)**,
plus every navigation — latency on every request and pressure on Supabase Auth
rate limits.

## 2. What Supabase currently recommends (fetched 2026-09-01)

From `supabase.com/docs/guides/auth/server-side/nextjs` and the `getClaims`
reference:

- *"Always use `supabase.auth.getClaims()` to protect pages and user data."*
- *"Prefer this method over `getUser` which always sends a request to the Auth
  server for each JWT."*
- `getClaims()` *"validates the JWT signature against the project's published
  public keys every time"* — safe for server-side authorization.
- It does local verification *"via the WebCrypto API and a cached JWKS endpoint
  when the project uses asymmetric signing keys (the default for new projects)."*
- Middleware still refreshes tokens via `request.cookies.set` and propagates via
  `response.cookies.set` — unchanged shape, only the validation method changes.

## 3. This project uses asymmetric (ES256) JWT signing — Verified

Checked the live project's public discovery endpoint (no credentials):

```
GET https://kbmdydpacvdmbemcwhry.supabase.co/auth/v1/.well-known/jwks.json
→ {"keys":[{"alg":"ES256","kty":"EC","crv":"P-256","use":"sig",
           "key_ops":["verify"],"kid":"a972f92b-...", ...}]}
```

One active **ES256 / ECDSA P-256** signing key. Therefore `getClaims()` does
**true local verification** (`crypto.subtle.verify` against the JWK) with **no
Auth-server round-trip** on the hot path. (Had it been symmetric HS256,
`getClaims()` would fall back to a `getUser()`-style server call — `auth-js`
`GoTrueClient.js:5340` — and there would be no win. Not our case.)

**JWKS caching (Verified in `auth-js` source):** `GLOBAL_JWKS` is a module-level
cache **shared across every Supabase client in the same JS instance**
(`GoTrueClient.js:46`), TTL **10 minutes** (`JWKS_TTL`). So on a warm Vercel
instance the JWKS is fetched at most once per 10 min *total*; every other
`getClaims()` call is pure local crypto. Cold start: one JWKS fetch
(Supabase-edge-cached).

**Token refresh is preserved:** `getClaims()` calls `getSession()` internally,
which refreshes the token when it is within `EXPIRY_MARGIN_MS` (90 s) of expiry
— `__loadSession`, `GoTrueClient.js:2523-2551` — **even though the SSR client
sets `autoRefreshToken: false`**. The new cookie is written through the existing
`setAll`. So the middleware's refresh responsibility is unchanged.

## 4. The change

| File | Before | After |
|---|---|---|
| `src/lib/supabase/middleware.ts` | `const { data: { user } } = await supabase.auth.getUser()` | `const { data } = await supabase.auth.getClaims(); ... sessionUserFromClaims(data)` |
| `src/server/auth.ts` | `({ data: { user: authUser } } = await supabase.auth.getUser())` | `const { data } = await supabase.auth.getClaims(); authUser = authUserFromClaims(data?.claims)` |

New pure module `src/lib/supabase/claims.ts`:

- `authUserFromClaims(claims)` → `{ id, email?, user_metadata? } | null` — the
  identity `getCurrentUser`'s find-or-create consumes. `email` / `user_metadata`
  are only read on a **first-ever sign-in**, when the JWT was just minted, so
  they are never stale in practice.
- `sessionUserFromClaims(data)` → `{ id } | null` — the middleware only needs
  "is there a valid session" for the `/sign-in` redirect decision.

Both resolve to `null` for **any** result that is not a fully-verified token
carrying a `sub` — `getClaims()` returns `{ data: null }` for a missing token,
an expired `exp`, or a failed signature check. Neither ever returns
`{ id: undefined }`.

**Unchanged:** the dev-auth-bypass branch, the env-not-configured `try/catch`
(same defensive contract that wrapped `getUser()`), `if (!authUser) return null`,
`requireUser()`'s throw, the `cache()` wrapper, the Prisma find-or-create,
`upsertUserFromSupabase`, the middleware redirect logic, `Cache-Control:
no-store`, and every client-side auth call (sign-in/up, reset, sign-out) and the
`/auth/callback` route (`exchangeCodeForSession`).

## 5. Overhead removed

| | Before | After |
|---|---|---|
| Auth-server round-trips / authenticated page load | 2 (serial) | **0** (steady state) |
| Auth-server round-trips / `/api/live/scores` poll | 2 | **0** |
| Added auth latency / request | [ESTIMATE] ~30–100 ms | **<1 ms** (2× local ECDSA verify) |
| JWKS fetches | — | ≤ 1 per 10 min **per warm instance** (shared cache); ~1 per cold start |
| Token-refresh calls | ~1 / hour / session | ~1 / hour / session (unchanged) |
| Polling Auth load @ 50k [ESTIMATE] | ~400 req/s | **~0** |

## 6. Security tradeoff — what `getUser()` gave that `getClaims()` does not

`getUser()`'s `GET /auth/v1/user` did two extra things:

1. Confirmed the JWT's `session_id` still maps to a **live session row** — so an
   explicit **remote sign-out**, an **admin session revocation**, or "log out
   everywhere" was caught **within one request** (`_getUser` →
   `AuthSessionMissingError`, `GoTrueClient.js:2704`).
2. Returned the current user record — so a **banned or deleted** user was
   rejected immediately.

`getClaims()` (local verify) trusts any validly-signed, unexpired access token
for its full lifetime.

**The window:** after a ban / delete / revoke / remote sign-out, the **refresh
token dies immediately** (the session cannot be extended), but the **existing
access token stays valid until it expires — up to the JWT expiry, currently
~1 h** — during which local verification passes. Hard lockout at ≤ 1 h,
automatic.

**Why this is accepted for this app:** there is no server action where a ≤1 h
stale session causes real harm. Password / email changes and sign-out run
through Supabase's own hosted client-side endpoints, not our server actions;
account deletion is not implemented; the "risky" server actions are billing (a
banned user paying us is not a threat) and a theme-preference toggle. Bans here
would be abuse / spam cleanup, where "gone within an hour" is fine.

**Levers if we ever want to tighten it (not done here):**

- **Lower the JWT expiry** (Supabase dashboard → Auth → Sessions, e.g. 3600 →
  900 s) — shrinks the window ~4×, at the cost of ~4× more refresh calls (still
  trivial vs. today's 2 network calls per request). This is the deferred
  decision noted at the top.
- **A `requireFreshUser()` (keeps `getUser()`) on specific sensitive actions** —
  instant enforcement on those low-frequency paths. Not added; no action in this
  app currently warrants it. Easy to introduce per-action later.

## 7. Verification performed

**Codebase audit for remaining forced network validation (as requested):**

- `grep` for `auth.getUser` / `auth.getSession` / `auth.getClaims` across `src/`.
- Server-side `getUser()` call sites remaining: **none.** The two hot-path
  callers (`lib/supabase/middleware.ts`, `server/auth.ts`) now use
  `getClaims()`; confirmed both.
- `auth/callback/route.ts` uses `exchangeCodeForSession` (a one-time OAuth /
  recovery landing, not a per-request check) — intentionally unchanged.
- `signInWithOAuth` / `signInWithPassword` / `resetPasswordForEmail` /
  `updateUser` / `signOut` — all in **client components** (`"use client"`, the
  browser client), one-time user actions, not on the server request path —
  intentionally unchanged.
- No `getSession()` used for authorization anywhere (Supabase: never trust it in
  server code).

**Automated:** `src/lib/supabase/claims-acceptance-test.ts` — 8 case groups +
2 invariants, pure (no react / next / prisma / network). Covers: verified OAuth
claims → full identity; verified claims missing `user_metadata` / `email` →
resolves with those undefined; `getClaims()` failure (`data: null`, i.e. no
token / expired / bad signature) → no user; claims without a usable `sub` → no
user; middleware `{ id }` for a verified token; middleware `null` for a failed
result; malformed shapes never produce `{ id: undefined }`; the invariant that
**no unverified or absent result ever resolves to a user**.

**Not automated (unchanged pre-existing behavior, not re-tested):** the
dev-auth-bypass branch, the env-missing `try/catch`, `requireUser()`'s throw on
`null`, and the `cache()`-wrapped first-sign-in `upsertUserFromSupabase` — these
wrappers are byte-for-byte the same around `getClaims()` as they were around
`getUser()`; only the one call and the result-mapping changed.

**Manual / staging (needs a live Supabase session — checklist, run before
relying on this in production):**

1. Sign in → navigate several protected pages → confirm **0** `GET
   /auth/v1/user` in Supabase Auth logs (was 2 per request); JWKS fetched ≤ once
   per 10 min.
2. Let an access token approach expiry mid-session → next request refreshes (one
   `/token` call), new cookie set, no logout.
3. Sign out in tab A → tab B loses access within ≤ the JWT expiry; confirm the
   refresh fails immediately (no silent extension).
4. Delete / ban the Supabase user → confirm lockout within the window.
5. `tsc --noEmit`, full `npm test`, `next build` — all green.
