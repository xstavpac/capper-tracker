// Dormant — UI removed Oct 2026, no callers. Returns 410 Gone so a direct hit
// can never trigger auth, upstream or DB work. The original handler is in git
// history.
export async function GET() {
  return Response.json({ error: "gone" }, { status: 410 });
}
