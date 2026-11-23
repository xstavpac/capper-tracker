// The solid blue "N pick(s)" capsule: on each /live game card, in the game detail header, and on the
// /live category tiles. One definition so the three never drift apart. Renders nothing at 0.
// bg-brand-600 with white text in both themes (5.2:1; the brighter brand-500 was only 3.7:1 in dark).
export function PicksCountPill({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="rounded-full bg-brand-600 bg-gradient-to-b from-[#4b83f5] to-[#1f55d6] px-2 py-0.5 text-[10.5px] font-semibold leading-none text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_2px_5px_-1px_rgba(37,99,235,0.5)]">
      {count} pick{count === 1 ? "" : "s"}
    </span>
  );
}
