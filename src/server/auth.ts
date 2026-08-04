import { auth, currentUser } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

export async function getCurrentUser() {
  const { userId: clerkId } = await auth();
  if (!clerkId) return null;

  let user = await prisma.user.findUnique({ where: { clerkId } });

  if (!user) {
    user = await upsertUserFromClerk(clerkId);
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
