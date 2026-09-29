// Small glyph per league for the /picks sport chips. Display-only.
const ICONS: Record<string, string> = {
  NBA: "🏀",
  WNBA: "🏀",
  NCAAB: "🏀",
  NFL: "🏈",
  NCAAF: "🏈",
  MLB: "⚾",
  NHL: "🏒",
  MLS: "⚽",
  EPL: "⚽",
  SOCCER: "⚽",
  TENNIS: "🎾",
  UFC: "🥊",
  MMA: "🥊",
  BOXING: "🥊",
  GOLF: "⛳",
};

export function sportIcon(sportName: string): string {
  return ICONS[sportName.toUpperCase()] ?? "🎯";
}
