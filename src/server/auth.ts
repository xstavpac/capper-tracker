import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export async function getCurrentUser() {
  const session = await auth();
  const googleId = (session as any)?.googleId as string | undefined;
  if (!googleId || !session?.user) return null;

  let user = await prisma.user.findUnique({ where: { googleId } });

  if (!user) {
    user = await upsertUserFromGoogleProfile(googleId, {
      email: session.user.email ?? "",
      name: session.user.name ?? undefined,
      picture: session.user.image ?? undefined,
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

// Called once per Google account on its first sign-in after this migration
// (or ever, for a brand-new user). Matches an existing row by email first -
// this app had real dev/test data under Clerk-issued ids before this
// migration, and linking by email carries that account (and everything tied
// to its userId - picks, cappers, etc.) forward instead of silently starting
// a second, empty account for the same person.
export async function upsertUserFromGoogleProfile(
  googleId: string,
  profile: { email: string; name?: string; picture?: string }
) {
  const existingByEmail = profile.email
    ? await prisma.user.findUnique({ where: { email: profile.email } })
    : null;

  if (existingByEmail) {
    return prisma.user.update({
      where: { id: existingByEmail.id },
      data: {
        googleId,
        name: profile.name ?? existingByEmail.name,
        profilePictureUrl: profile.picture ?? existingByEmail.profilePictureUrl,
      },
    });
  }

  return prisma.user.create({
    data: {
      googleId,
      email: profile.email,
      name: profile.name,
      profilePictureUrl: profile.picture,
      subscription: {
        create: { plan: "FREE", status: "active" },
      },
    },
  });
}
