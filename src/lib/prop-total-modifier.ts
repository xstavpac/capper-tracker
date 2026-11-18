// "total" in front of a player-prop market word ("Anton Lundell over 0.5 total points", "Bijan Robinson
// over 80.5 total rushing yards") is part of the MARKET, not of the player's name. Each sport's parser
// removes its own market words from the text to leave the name, but it never knew about "total", so the
// name came out as "Anton Lundell total" and grading could not find that player in the box score.
//
// Removed ONLY when it sits directly before the market the parser matched. Nothing else changes:
//   - a game / team total ("Over 6.5 total", "Panthers over 6.5 total goals") never reaches a player-prop
//     parser's name step, so this never runs on one;
//   - "total" anywhere else in the text stays where it is ("Total Hockey over 0.5 points" keeps its name);
//   - MLB "total bases" is a market of its own: mlb-prop.ts's market regex already contains the word and
//     does not call this.
export function stripTotalBeforeMarket(text: string, market: RegExp): string {
  return text.replace(new RegExp(String.raw`\btotal\s+(?=(?:${market.source}))`, "gi"), " ");
}
