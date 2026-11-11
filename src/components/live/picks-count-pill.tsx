// The solid blue "N pick(s)" capsule: on each /live game card, in the game detail header, and on the
// /live category tiles. One definition so the three never drift apart. Renders nothing at 0.
// Light: the deeper accent blue (brand-600). Dark: the brighter step (brand-500). White text in both.
export function PicksCountPill({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="rounded-full bg-brand-600 px-2 py-0.5 text-[10.5px] font-semibold leading-none text-white dark:bg-brand-500">
      {count} pick{count === 1 ? "" : "s"}
    </span>
  );
}
