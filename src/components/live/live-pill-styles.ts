// The /live pills under the banner (leagues, Parlay slip, Feed / Grid). 46px tall, nothing above
// weight 600. Off = white glass; on = blue gradient with a glow.
export const LIVE_PILL =
  "inline-flex h-[46px] flex-none items-center gap-2 whitespace-nowrap rounded-full border pl-[10px] pr-4 text-[14px] font-semibold leading-none transition ";
export const LIVE_PILL_OFF =
  "border-[#dbe5f6] bg-[rgba(255,255,255,.8)] text-[#0b1838] shadow-[0_2px_10px_rgba(30,64,175,.08)] hover:bg-white ";
export const LIVE_PILL_ON =
  "border-transparent bg-[linear-gradient(180deg,#3b82f6,#1d4ed8)] text-white shadow-[0_6px_18px_rgba(37,99,235,.45),inset_0_1px_0_rgba(255,255,255,.35)] ";
// A row of pills: 8px between them, scrolls sideways (no visible bar) when it overflows. The
// vertical padding keeps the pills' shadows from being clipped by the overflow.
export const LIVE_PILL_ROW =
  "-my-2 flex gap-2 overflow-x-auto py-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
