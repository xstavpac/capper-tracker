// The one container for the app shell's CONTENTS: the site header's row, the page banner's card and
// ThemedPage's content all use it, so the logo, the banner card and the page content share the same
// left and right edges at every width. 1280px max (border-box, so 1232px of content), centered,
// 24px side padding (16px below 640px), each side max()'d with the safe-area inset so a landscape phone's notch never covers content (the insets are 0 elsewhere). The backgrounds - ticker, navy header bar, navy banner
// band, page backdrop - stay full-bleed; only what sits on them is contained.
export const SHELL_CONTAINER = "mx-auto w-full max-w-[1280px] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))]";
