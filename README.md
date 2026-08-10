# Capper Tracker

Private analytics platform for tracking the sports betting cappers you follow.

## Milestone 2 — what's included

- Full Prisma schema (`prisma/schema.prisma`): Users, Subscriptions, Sports,
  Leagues, Cappers, Picks — normalized, indexed for per-user queries.
- Seed script for reference data (sports/leagues only — user data is never
  seeded, since it's private).
- Sign-in via Supabase Auth (Google + email/password): middleware route
  protection, custom sign-in/sign-up/forgot-password pages, session cookies
  managed by `@supabase/ssr` - the app's own `users` table is populated
  directly on first sign-in, matched by email if the row already exists.
- A `server/auth.ts` + `server/data/*` layer — every database query goes
  through here, always scoped by `userId`, so no view can accidentally leak
  another user's data.
- A working dashboard page pulling real (if empty) stats: record, ROI, net
  units, pending picks, recent picks, top capper.
- Placeholder pages for Cappers, Picks, Reports, Settings (next milestones).

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Set up Supabase**

   Create a free project at [supabase.com](https://supabase.com) (or reuse
   an existing one) - copy its Postgres connection string for
   `DATABASE_URL`/`DIRECT_URL`, and its Project URL + anon key from
   Settings > API.

3. **Set up sign-in providers in the Supabase dashboard**

   Under Authentication > Providers: enable **Google** (paste your Client
   ID/Secret from
   [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   and add Supabase's callback URL -
   `https://<project-ref>.supabase.co/auth/v1/callback` - as an authorized
   redirect URI there), and confirm **Email** is enabled. Under
   Authentication > URL Configuration, add `http://localhost:3000/**` and
   your production domain to the allowed redirect URLs.

4. **Configure environment variables**

   ```bash
   cp .env.example .env
   ```

   Fill in `DATABASE_URL` and the two `NEXT_PUBLIC_SUPABASE_*` values.

5. **Run migrations and seed reference data**

   ```bash
   npx prisma migrate dev --name init
   npm run prisma:seed
   ```

6. **Run the dev server**

   ```bash
   npm run dev
   ```

   Visit `http://localhost:3000`, sign in, and you'll land on an empty
   dashboard — ready for Milestone 3 (the actual Capper + Pick creation UI).

## Local dev auth bypass

Verifying a UI change shouldn't require a real Supabase sign-in every time,
so `next dev` supports an opt-in bypass:

```bash
echo "DEV_AUTH_BYPASS=true" >> .env.local
npm run dev
```

Visiting any page now logs you in automatically as a dedicated local-only
account (`dev-local@bettingview.test`, an address on the `.test` TLD, which
[RFC 2606](https://www.rfc-editor.org/rfc/rfc2606) reserves so it can never
be a real, reachable address) - a completely ordinary FREE-plan `User` row,
created the first time it's needed via the same `upsertUserFromSupabase()`
path a real first sign-in uses, so every page behaves exactly as it would
for a genuine account (starts with zero cappers/picks, same as any new
sign-up). It's entirely separate from your real account and from
production data - nothing here ever touches Supabase Auth or writes to a
deployed database.

If you reset your local database (`npx prisma migrate reset` or similar),
nothing extra is needed - the bypass account is just a normal row and gets
recreated automatically the next time you load a page.

**Why this is inert everywhere except your own local dev server:** it
requires `NODE_ENV=development`, which only `next dev` sets - any built and
deployed app (`next build` + `next start`, what Vercel always runs for both
preview and production) has `NODE_ENV=production` regardless of what env
vars are set, so there's no configuration that turns this on outside
`next dev`. `.env.local` is also gitignored, so the flag itself never leaves
your machine.

## Deploying

Push to a GitHub repo and import it in Vercel — it will build automatically.
Add the same `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`
environment variables in the Vercel project settings, and add your
production domain to Supabase's allowed redirect URLs.

## Next milestone (3)

- Capper creation/edit UI (with the free-plan 2-capper limit already
  enforced in `server/data/cappers.ts`)
- Pick creation/edit UI, including all bet types and the `PickStatus` flow
- Wiring the Reports and per-capper detail pages to `computeStats()`
