# Capper Tracker

Private analytics platform for tracking the sports betting cappers you follow.

## Milestone 2 — what's included

- Full Prisma schema (`prisma/schema.prisma`): Users, Subscriptions, Sports,
  Leagues, Cappers, Picks — normalized, indexed for per-user queries.
- Seed script for reference data (sports/leagues only — user data is never
  seeded, since it's private).
- Google-only sign-in via NextAuth/Auth.js: middleware route protection, a
  sign-in page, JWT sessions - no separate auth-provider webhook, the app's
  own `users` table is populated directly on first sign-in.
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

2. **Set up Postgres**

   Create a free Postgres database at [neon.tech](https://neon.tech) or
   [Vercel Postgres](https://vercel.com/storage/postgres), and copy the
   connection string.

3. **Set up Google sign-in**

   Create an OAuth Client ID (Web application) at
   [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
   Add authorized redirect URIs for both dev and prod:
   `http://localhost:3000/api/auth/callback/google` and
   `https://<your-domain>/api/auth/callback/google`. Copy the client ID and
   secret.

4. **Configure environment variables**

   ```bash
   cp .env.example .env
   ```

   Fill in `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and
   `AUTH_SECRET` (generate one with
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).

5. **Run migrations and seed reference data**

   ```bash
   npx prisma migrate dev --name init
   npm run prisma:seed
   ```

6. **Run the dev server**

   ```bash
   npm run dev
   ```

   Visit `http://localhost:3000`, sign in with Google, and you'll land on an
   empty dashboard — ready for Milestone 3 (the actual Capper + Pick creation
   UI).

## Deploying

Push to a GitHub repo and import it in Vercel — it will build automatically.
Add the same environment variables in the Vercel project settings (using
your production domain in the Google OAuth redirect URI and
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`AUTH_SECRET`).

## Next milestone (3)

- Capper creation/edit UI (with the free-plan 2-capper limit already
  enforced in `server/data/cappers.ts`)
- Pick creation/edit UI, including all bet types and the `PickStatus` flow
- Wiring the Reports and per-capper detail pages to `computeStats()`
