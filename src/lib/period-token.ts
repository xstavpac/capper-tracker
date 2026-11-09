// A period / half / quarter token written beside a player prop ("Fox over 0.5 points 1P"):
// 1P-3P, 1H/2H, 1Q-4Q, Q1-Q4. betScope reads the scope from the same text; the player-name
// parsers strip the token so its letter never survives the number strip as part of the name
// ("Fox P"). A "(1P)" parenthetical is already removed by the parsers' own paren strip.
export const PERIOD_TOKEN_RE = /\b(?:[1-3]p|[12]h|[1-4]q|q[1-4])\b/gi;
