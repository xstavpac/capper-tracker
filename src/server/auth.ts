import { cache } from "react";
import { Prisma } from "@prisma/client";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { isDevAuthBypassEnabled, DEV_BYPASS_SUPABASE_ID, DEV_BYPASS_EMAIL, DEV_BYPASS_NAME } from "@/lib/dev-auth-bypass";

// Wrapped in React's cache() so every caller within the same request (the
// (app) layout AND whichever page is rendering both call this independently)
// shares one resolved result instead of racing separate upserts - on a
// user's very first sign-in, two concurrent calls with no existing row would
// otherwise both attempt prisma.user.create() for the same email and one
// loses to a P2002 unique-constraint crash.
export const getCurrentUser = cache(async () => {
  // Local-dev-only - see lib/dev-auth-bypass.ts. Skips Supabase entirely
  // rather than special-casing it, so every other code path below (find-or-
  // create the Prisma User row) runs exactly as it would for a real sign-in.
  let authUser: { id: string; email?: string; user_metadata?: Record<string, unknown> } | null = null;
  if (isDevAuthBypassEnabled()) {
    authUser = { id: DEV_BYPASS_SUPABASE_ID, email: DEV_BYPASS_EMAIL, user_metadata: { full_name: DEV_BYPASS_NAME } };
  } else {
    // Middleware already gates every protected route on a resolved session,
    // but guard here too (defense in depth) - Supabase's client throws
    // synchronously if its URL/key aren't configured, and that would 500 the
    // whole page's Server Component render instead of just failing auth.
    try {
      const supabase = await createSupabaseServerClient();
      ({
        data: { user: authUser },
      } = await supabase.auth.getUser());
    } catch (err) {
      console.error("[auth] Supabase session check failed:", err);
      return null;
    }
  }
  if (!authUser) return null;

  let user = await prisma.user.findUnique({ where: { supabaseId: authUser.id } });

  if (!user) {
    user = await upsertUserFromSupabase(authUser.id, {
      email: authUser.email ?? "",
      name: (authUser.user_metadata?.full_name as string | undefined) ?? (authUser.user_metadata?.name as string | undefined),
      picture: authUser.user_metadata?.avatar_url as string | undefined,
    });
  }

  return user;
});

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("Not authenticated");
  }
  return user;
}

// Called once per Supabase auth user on their first sign-in after this
// migration (or ever, for a brand-new user) - regardless of whether they
// signed in with Google or email/password, Supabase gives every person one
// stable `auth.users.id`. Matches an existing row by email first - this app
// had real dev/test data under Google-issued ids before this migration, and
// linking by email carries that account (and everything tied to its userId -
// picks, cappers, etc.) forward instead of silently starting a second, empty
// account for the same person.
export async function upsertUserFromSupabase(
  supabaseId: string,
  profile: { email: string; name?: string; picture?: string }
) {
  const existingByEmail = profile.email
    ? await prisma.user.findUnique({ where: { email: profile.email } })
    : null;

  if (existingByEmail) {
    return prisma.user.update({
      where: { id: existingByEmail.id },
      data: {
        supabaseId,
        name: profile.name ?? existingByEmail.name,
        profilePictureUrl: profile.picture ?? existingByEmail.profilePictureUrl,
      },
    });
  }

  try {
    return await prisma.user.create({
      data: {
        supabaseId,
        email: profile.email,
        name: profile.name,
        profilePictureUrl: profile.picture,
        subscription: {
          create: { plan: "FREE", status: "active" },
        },
      },
    });
  } catch (err) {
    // Two truly concurrent requests (e.g. separate tabs) can both pass the
    // check above before either commits - cache() above closes that gap
    // within a single request, but not across requests. If we lost that
    // race, the row now exists; fetch what the other request created
    // instead of crashing.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && profile.email) {
      const winner = await prisma.user.findUnique({ where: { email: profile.email } });
      if (winner) return winner;
    }
    throw err;
  }
}
