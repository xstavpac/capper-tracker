import { createSupabaseServerClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";

export async function getCurrentUser() {
  // Middleware already gates every protected route on a resolved session,
  // but guard here too (defense in depth) - Supabase's client throws
  // synchronously if its URL/key aren't configured, and that would 500 the
  // whole page's Server Component render instead of just failing auth.
  let authUser;
  try {
    const supabase = await createSupabaseServerClient();
    ({
      data: { user: authUser },
    } = await supabase.auth.getUser());
  } catch (err) {
    console.error("[auth] Supabase session check failed:", err);
    return null;
  }
  if (!authUser) return null;

  let user = await prisma.user.findUnique({ where: { supabaseId: authUser.id } });

  if (!user) {
    // TEMPORARY - diagnosing the dashboard P2002 create-vs-update race, remove
    // once the real cause is confirmed and fixed.
    console.error("[auth] no user by supabaseId, calling upsert:", {
      supabaseId: authUser.id,
      authUserEmail: authUser.email,
      callStack: new Error().stack?.split("\n").slice(1, 4).join(" | "),
    });
    user = await upsertUserFromSupabase(authUser.id, {
      email: authUser.email ?? "",
      name: (authUser.user_metadata?.full_name as string | undefined) ?? (authUser.user_metadata?.name as string | undefined),
      picture: authUser.user_metadata?.avatar_url as string | undefined,
    });
  }

  return user;
}

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

  // TEMPORARY - diagnosing the dashboard P2002 create-vs-update race, remove
  // once the real cause is confirmed and fixed.
  console.error("[auth] upsertUserFromSupabase lookup result:", {
    supabaseId,
    profileEmail: profile.email,
    profileEmailType: typeof profile.email,
    foundExistingByEmail: !!existingByEmail,
    existingId: existingByEmail?.id,
  });

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

  return prisma.user.create({
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
}
