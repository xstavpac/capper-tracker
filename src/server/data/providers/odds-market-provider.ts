// Wraps the odds/market variables - both resolveLive and resolveHistorical
// read real market prices (the live game's current OddsGame, or a historical
// game's own OddsSnapshot respectively), so unlike the other two providers
// this one is fully point-in-time correct in both modes - there's no
// "current data standing in for the past" simplification here.
import { spreadPoint, totalLine } from "@/server/data/team-tendencies";
import type { VariableProvider } from "./types";

export const oddsMarketProvider: VariableProvider = {
  sourceId: "odds_api",
  supportsHistorical: () => true,

  resolveLive(ctx, variableId) {
    switch (variableId) {
      case "market_favorite_moneyline":
        return ctx.favoriteMoneyline;
      case "market_underdog_moneyline":
        return ctx.underdogMoneyline;
      case "market_spread":
        return ctx.spread;
      case "market_total_line":
        return ctx.totalLine;
      default:
        return null;
    }
  },

  resolveHistorical(ref, variableId) {
    switch (variableId) {
      case "market_favorite_moneyline":
        return ref.favoriteMoneyline;
      case "market_underdog_moneyline":
        return ref.underdogMoneyline;
      case "market_spread":
        return spreadPoint(ref.oddsGame, ref.favoriteTeam);
      case "market_total_line":
        return totalLine(ref.oddsGame);
      default:
        return null;
    }
  },
};
