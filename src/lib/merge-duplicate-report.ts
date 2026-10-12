// What the UI says about the duplicate picks a capper merge left behind (see
// mergeCappers / findMergeDuplicates). The merge moves every pick and deletes
// none; these lines only tell the user which pairs are now the same bet under
// one capper, so they can decide what to do with them.
//
// Pure, and typed structurally so client components can import it without
// pulling in server code.
export type MergeDuplicateLine = {
  keptPickId: string;
  movedPickId: string;
  keptLabel: string;
  movedLabel: string;
  homeTeam: string;
  awayTeam: string;
  gameTime: Date | string;
};

export function mergeDuplicateHeadline(count: number): string {
  if (count === 0) return "";
  return (
    count +
    " moved pick" +
    (count === 1 ? " is" : "s are") +
    " now a duplicate of a pick this capper already had. Nothing was deleted - review " +
    (count === 1 ? "it" : "them") +
    " and remove the copy you don't want."
  );
}

export function mergeDuplicateLines(duplicates: MergeDuplicateLine[]): string[] {
  return duplicates.map((d) => {
    const day = new Date(d.gameTime).toISOString().slice(0, 10);
    const bets = d.keptLabel === d.movedLabel ? '"' + d.keptLabel + '"' : '"' + d.keptLabel + '" / "' + d.movedLabel + '"';
    return d.awayTeam + " @ " + d.homeTeam + " (" + day + "): " + bets + " - picks " + d.keptPickId + " and " + d.movedPickId;
  });
}

// The capper profile page navigates away as soon as its merge finishes (the
// merged capper's page no longer exists), so the report rides along in
// sessionStorage and is shown once on the surviving capper's page.
export const mergeDuplicateStorageKey = (survivingCapperId: string) => "merge-duplicates:" + survivingCapperId;
