// Gates the "Build Your Own Model" feature - defaults to off (unset, or
// anything other than the literal string "true") so it doesn't appear until
// explicitly turned on via a Vercel env var. Checked against a literal
// "true" rather than mere presence (the ODDS_API_KEY convention elsewhere in
// this app) since this flag has no secret value whose presence alone implies
// "enabled" - it's a pure on/off switch.
export function isModelBuilderEnabled(): boolean {
  return process.env.MODEL_BUILDER_ENABLED === "true";
}
