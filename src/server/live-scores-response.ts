// The body of GET /api/live/scores, with its two collaborators passed in so the
// auth boundary and the response shape can be tested without Supabase, a
// database or the odds feed (live-scores-response-acceptance-test.ts).
//
// Behind a session for consistency with the rest of the app - the underlying
// score data isn't sensitive, but this is an externally-pollable endpoint and
// every other data path here already requires a session. Only the session is
// needed, not a users row (requireSession, auth-session.ts): the route polls
// every 25 s per open tab and used to read `users` on each call to throw the
// row away.
export type LiveScoresDeps = {
  requireSession: () => Promise<unknown>;
  getScores: (sportKey: string) => Promise<unknown>;
};

export async function liveScoresResponse(request: Request, deps: LiveScoresDeps): Promise<Response> {
  try {
    await deps.requireSession();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const sportKey = searchParams.get("sport");
  if (!sportKey) {
    return Response.json({ error: "missing sport" }, { status: 400 });
  }

  const scores = await deps.getScores(sportKey);
  return Response.json({ scores });
}
