# Capper Tracker

Private analytics platform for tracking the sports betting cappers you follow.

## Milestone 2 — what's included

- Full Prisma schema (`prisma/schema.prisma`): Users, Subscriptions, Sports,
  Leagues, Cappers, Picks — normalized, indexed for per-user queries.
- Seed script for reference data (sports/leagues only — user data is never
  seeded, since it's private).
- Clerk auth wiring: middleware route protection, sign-in/sign-up pages,
  a webhook that syncs Clerk users into Postgres.
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
   npm install svix   # required by the Clerk webhook route
   ```

2. **Set up Postgres**

   Create a free Postgres database at [neon.tech](https://neon.tech) or
   [Vercel Postgres](https://vercel.com/storage/postgres), and copy the
   connection string.

3. **Set up Clerk**

   Create a free app at [clerk.com](https://clerk.com). Copy the
   publishable key and secret key. Under Webhooks, add an endpoint pointing
   at `https://<your-domain>/api/webhooks/clerk` subscribed to
   `user.created`, `user.updated`, `user.deleted`, and copy the signing
   secret.

4. **Configure environment variables**

   ```bash
   cp .env.example .env
   ```

   Fill in `DATABASE_URL`, the Clerk keys, and `CLERK_WEBHOOK_SECRET`.

5. **Run migrations and seed reference data**

   ```bash
   npx prisma migrate dev --name init
   npm run prisma:seed
   ```

6. **Run the dev server**

   ```bash
   npm run dev
   ```

   Visit `http://localhost:3000`, sign up, and you'll land on an empty
   dashboard — ready for Milestone 3 (the actual Capper + Pick creation UI).

## Deploying

Push to a GitHub repo and import it in Vercel — it will build automatically.
Add the same environment variables in the Vercel project settings, and
update your Clerk webhook URL to point at your Vercel deployment (or your
custom domain, once you add one — no code changes required either way).

## Next milestone (3)

- Capper creation/edit UI (with the free-plan 2-capper limit already
  enforced in `server/data/cappers.ts`)
- Pick creation/edit UI, including all bet types and the `PickStatus` flow
- Wiring the Reports and per-capper detail pages to `computeStats()`
