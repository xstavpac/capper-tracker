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
