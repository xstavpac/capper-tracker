// The /live pills under the banner (leagues, Parlay slip, Feed / Grid). 46px tall, nothing above
// weight 600. Off = white glass; on = blue gradient.
export const LIVE_PILL =
  "inline-flex h-[46px] flex-none items-center gap-2 whitespace-nowrap rounded-full border pl-[10px] pr-4 text-[14px] font-semibold leading-none transition ";
export const LIVE_PILL_OFF =
  "border-[#dbe5f6] bg-[rgba(255,255,255,.8)] text-[#0b1838] shadow-[0_1px_2px_rgba(17,26,46,.06)] hover:bg-white ";
export const LIVE_PILL_ON =
  "border-transparent bg-[linear-gradient(180deg,#3b82f6,#1d4ed8)] text-white shadow-[0_1px_2px_rgba(17,26,46,.06),inset_0_1px_0_rgba(255,255,255,.35)] ";
// A row of pills: 8px between them, scrolls sideways (no visible bar) when it overflows. The
// padding (and the matching negative margin) keeps the pills' shadows from being clipped by the overflow.
export const LIVE_PILL_ROW =
  "-mx-4 -my-5 flex gap-2 overflow-x-auto px-4 py-5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
