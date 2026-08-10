// The deep-link bridge between other pages (Charts, Slate) and the Model
// Builder - "Add as condition"/"Build a model for this game" both send the
// user to /model-builder with a variable pre-selected via plain URL query
// params, rather than sessionStorage or a second cross-page state mechanism.
// Fits cleanly here specifically because there are only ever two small,
// human-readable values to carry (a variableId and an optional side) - if a
// future caller needs to hand off something larger/more structured, that's a
// real signal to revisit this approach rather than stretch it.
import type { VariableSide } from "@/lib/model-builder";

export function buildModelBuilderPrefillUrl(variableId: string, side?: VariableSide): string {
  const params = new URLSearchParams({ variableId });
  if (side) params.set("side", side);
  return "/model-builder?" + params.toString();
}

export type ModelBuilderPrefill = { variableId: string; side?: VariableSide };

// Parses/validates the raw searchParams a Server Component page receives -
// returns null for anything malformed rather than letting a bad/stale link
// silently seed a broken condition. Actual variable-existence and
// side-requirement validation happens where the condition is created
// (ModelBuilderClient), same as manually adding one from the library.
export function parseModelBuilderPrefill(searchParams: { variableId?: string; side?: string }): ModelBuilderPrefill | null {
  const variableId = searchParams.variableId?.trim();
  if (!variableId) return null;
  const side = searchParams.side === "favorite" || searchParams.side === "underdog" ? searchParams.side : undefined;
  return { variableId, side };
}
