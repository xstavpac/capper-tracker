"use server";

// Bot API tokens: the Settings actions (UI comes in a later PR). Session-authenticated; every action works on the
// signed-in user's own tokens only. Available on every plan. See src/server/data/api-tokens.ts.
import { requireUser } from "@/server/auth";
import {
  createApiTokenForUser,
  listApiTokensForUser,
  revokeApiTokenForUser,
  type ApiTokenListItem,
  type CreateApiTokenResult,
  type RevokeApiTokenResult,
} from "@/server/data/api-tokens";

/** The raw token is in this result and nowhere else: show it once, never log it. */
export async function createApiToken(name: string): Promise<CreateApiTokenResult> {
  const user = await requireUser();
  return createApiTokenForUser(user.id, name);
}

export async function revokeApiToken(id: string): Promise<RevokeApiTokenResult> {
  const user = await requireUser();
  return revokeApiTokenForUser(user.id, id);
}

export async function listApiTokens(): Promise<ApiTokenListItem[]> {
  const user = await requireUser();
  return listApiTokensForUser(user.id);
}
