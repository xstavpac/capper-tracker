import { headers } from "next/headers";
import { Webhook } from "svix";
import { prisma } from "@/lib/prisma";
import { upsertUserFromClerk } from "@/server/auth";

// Clerk calls this whenever a user is created, updated, or deleted.
// This keeps our Postgres `users` table in sync with Clerk as the
// identity source of truth. Add "svix" to package.json when wiring this up.
export async function POST(req: Request) {
  const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return new Response("Missing CLERK_WEBHOOK_SECRET", { status: 500 });
  }

  const headerPayload = headers();
  const svixId = headerPayload.get("svix-id");
  const svixTimestamp = headerPayload.get("svix-timestamp");
  const svixSignature = headerPayload.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return new Response("Missing svix headers", { status: 400 });
  }

  const body = await req.text();
  const wh = new Webhook(webhookSecret);

  let event: any;
  try {
    event = wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    });
  } catch (err) {
    return new Response("Invalid webhook signature", { status: 400 });
  }

  const eventType = event.type;
  const clerkId = event.data.id;

  if (eventType === "user.created" || eventType === "user.updated") {
    await upsertUserFromClerk(clerkId);
  }

  if (eventType === "user.deleted") {
    await prisma.user.deleteMany({ where: { clerkId } });
  }

  return new Response("ok", { status: 200 });
}
