// Shapes for the DATA resolver layer (Build Step 2). Concrete, not
// speculative - each field exists because one of the three wrapped
// resolvers (readRate / resolveTeamStatFromSnapshot /
// resolvePitcherStatFromSnapshot) already requires it, not because the
// contract might someday need it.

// The two entity shapes every existing resolver actually keys its query by
// - a team by name (team_tendencies, team_stats) or a pitcher by MLB Stats
// API numeric id (pitcher_stats). Not a generic `{ type: string; id: string
// }` - that would let a caller pass a pitcher id where a team name belongs
// and only fail once the query returns nothing, instead of at the type
// level.
export type EntityRef = { type: "team"; teamName: string } | { type: "pitcher"; pitcherId: number };

// Every one of the three snapshot tables' queries is scoped by sportKey -
// the one piece of context every existing resolver signature actually
// needs. Nothing speculative added beyond that.
export type EvaluationContext = { sportKey: string };

export type ResolvedValue = {
  value: number | null;
  // The snapshot row's own date (as an Eastern-midnight-anchored Date -
  // see resolver.ts's snapshotDateToTimestamp), not "now" and not the
  // asOf passed in. Null only when found is false.
  timestamp: Date | null;
  // False when no snapshot row exists at or before asOf for this entity -
  // not an error, not a fabricated default. True whenever a qualifying row
  // was located, even if that row's own derived value is null (e.g. a
  // team_tendencies rate below MIN_TENDENCY_SAMPLE) - found describes
  // whether point-in-time data existed, not whether the computed value
  // happened to be non-null.
  found: boolean;
};
