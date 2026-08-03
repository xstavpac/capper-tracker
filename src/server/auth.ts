import { auth, currentUser } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

/**
 * Returns the app's User row for the signed-in Clerk session, or null.
 * This is the ONLY place that should translate a Clerk session into
 * an application User. Every data-access function calls this (or
 * requireUser below) instead of touching Clerk directly, so there is
 * exactly one place that can get the user-scoping logic wrong.
 */
export async function getCurrentUser() {
  const { userId: clerkId } = auth();
  if (!clerkId) return null;

  const user = await prisma.user.findUnique({ where: { clerkId } });
  return user;
}

/**
 * Same as getCurrentUser, but throws if there's no session or no
 * matching User row. Use this at the top of every Server Action and
 * every data-layer read/write so unauthenticated or unsynced access
 * fails loudly instead of silently leaking a null userId into a query.
 */
export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("Not authenticated");
  }
  return user;
}

/**
 * Convenience used by the Clerk webhook to create/update the local
 * User row whenever someone signs up or edits their Clerk profile.
 */
export async function upsertUserFromClerk(clerkId: string) {
  const clerkUser = await currentUser();
  if (!clerkUser) return null;

  const email = clerkUser.emailAddresses[0]?.emailAddress ?? "";

  return prisma.user.upsert({
    where: { clerkId },
    update: {
      email,
      name: clerkUser.fullName ?? undefined,
      profilePictureUrl: clerkUser.imageUrl ?? undefined,
    },
    create: {
      clerkId,
      email,
      name: clerkUser.fullName ?? undefined,
      profilePictureUrl: clerkUser.imageUrl ?? undefined,
      subscription: {
        create: { plan: "FREE", status: "active" },
      },
    },
  });
}
