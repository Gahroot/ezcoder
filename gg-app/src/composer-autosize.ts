// Auto-grow the chat textarea to fit its content, up to a CSS max-height after
// which it scrolls — without disturbing the transcript scrolling above it.
//
// Lives outside App.tsx so the scroll-preservation contract below is testable
// (`composer-autosize.test.ts` models the browser's clamp; jsdom has no layout).
//
// Measure with the scrollbar suppressed. `height: auto` collapses the textarea
// to its rows=1 intrinsic height, so any wrapped draft overflows during
// measurement, and `.input::-webkit-scrollbar` is a classic (space-consuming)
// scrollbar in WebKit — verified 8px of content width lost while it shows.
// Suppressing it first means every read below sees the width the text is
// actually laid out at, including the overflow decision itself.
export function autosizeComposer(
  el: HTMLTextAreaElement | null,
  transcript: HTMLElement | null,
  pinned = false,
): void {
  if (!el) return;
  // That same `height: auto` collapse hands the composer's pixels back to the
  // transcript for one layout pass. If the transcript's content fits in the
  // briefly-taller viewport, the browser clamps its scrollTop toward 0; the
  // scroll event that follows reads as "the user scrolled up", drops App's
  // stick-to-bottom pin for good, and from then on the growing composer covers
  // the newest messages instead of pushing them up. It only shows past ~3 line
  // breaks, where the lost distance clears the pin's 48px threshold. Snapshot
  // and restore around the measurement so the collapse stays invisible: both
  // writes land in the same task, so the browser fires at most one scroll
  // event, carrying the restored offset.
  const savedTop = transcript?.scrollTop;
  el.style.overflowY = "hidden";
  // `.input` transitions its height, and reading scrollHeight below forces a
  // synchronous layout — so without care the browser takes the collapsed `auto`
  // height as the transition's start value and animates 1 line → N on EVERY
  // keystroke. Snapshot the real height, restore it, and force ONE more layout
  // so that restored value is what the browser commits as the start; only then
  // write the target. Skipping the second read makes the restore invisible
  // (the browser coalesces both writes) and the animation breaks again.
  const before = el.style.height;
  el.style.height = "auto";
  const max = parseFloat(getComputedStyle(el).maxHeight) || Infinity;
  const content = el.scrollHeight;
  const next = `${Math.min(content, max)}px`;
  if (before !== next) {
    el.style.height = before;
    void el.offsetHeight;
  }
  el.style.height = next;
  // Only past the cap does the scrollbar earn its width. Below it, keeping
  // overflow hidden also avoids a phantom grey scrollbar under CSS zoom > 1,
  // where scrollHeight rounds down to an integer of unzoomed px and leaves the
  // content a hair taller than the height just set.
  if (content > max) el.style.overflowY = "auto";
  // One line keeps the caret beside the paperclip; past that the field claims
  // the whole row and the circles drop beneath it, moving the text up and left.
  // Compared against the padded height of a single line (scrollHeight includes
  // the field's vertical padding), so an empty draft with one newline counts as
  // exactly two lines rather than tipping over a pixel guess.
  const row = el.closest(".inputrow");
  if (row) {
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 0;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) || 0;
    const next = line > 0 && content > line + pad + 1;
    if (next !== row.classList.contains("is-multiline")) {
      // A flex reflow cannot be transitioned — the field teleports up and left
      // the instant it claims the row. FLIP it instead: measure where it was,
      // let the reflow happen, then translate it back to the old position and
      // release, so CSS animates the offset away. The browser only ever paints
      // the smooth path.
      const stack = el.parentElement;
      const first = stack?.getBoundingClientRect();
      row.classList.toggle("is-multiline", next);
      const last = stack?.getBoundingClientRect();
      if (stack && first && last) {
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        if (dx || dy) {
          stack.style.transition = "none";
          stack.style.transform = `translate(${dx}px, ${dy}px)`;
          // Commit the inverted position before clearing it, or both writes
          // coalesce and nothing animates.
          void stack.offsetHeight;
          stack.style.transition = "";
          stack.style.transform = "";
        }
      }
    }
  }
  if (!transcript || savedTop === undefined) return;
  // Where the transcript belongs now that the composer has its final height.
  // While pinned that is the true bottom, NOT the snapshot: a grown composer
  // eats pixels off the bottom of the viewport, so restoring the old offset
  // leaves the newest line under the fold and hands the correction to the
  // ResizeObserver a frame later — a visible bounce on every keystroke that
  // wraps. Landing at the bottom in the same task makes the growth one motion.
  const target = pinned ? transcript.scrollHeight : savedTop;
  if (transcript.scrollTop !== target) transcript.scrollTop = target;
}
