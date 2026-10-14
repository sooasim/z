/**
 * Page arithmetic for a horizontal `.rail` (see components/rail-pager.tsx).
 *
 * Kept here, free of React and the DOM, because this is the part that gets the edge cases wrong:
 * a row that fits but overflows by a sub-pixel, a last page that is only partly filled, and a
 * scroll position past the final page after a rubber-band swipe.
 */

/** Overflow below this many pixels is layout rounding, not a page worth offering. */
const SLACK = 2;

/**
 * How many viewport-sized pages the rail spans. Derived from the measured widths rather than the item
 * count, because how many cards fit changes with the breakpoint (4 on desktop, ~2 at 640px, ~1 below).
 */
export function railPages(scrollWidth: number, clientWidth: number): number {
  const w = Math.max(1, clientWidth);
  const over = Math.max(0, scrollWidth - clientWidth);
  if (over <= SLACK) return 1;
  return Math.ceil(over / w) + 1;
}

/** Which page a scroll offset sits on, clamped into the range `railPages` reports. */
export function railPage(scrollLeft: number, clientWidth: number, pages: number): number {
  const w = Math.max(1, clientWidth);
  const raw = Math.round(Math.max(0, scrollLeft) / w);
  return Math.max(0, Math.min(raw, Math.max(0, pages - 1)));
}

/** Pager style: numbers stay scannable up to eight, beyond that use dots. */
export function railNumbered(pages: number): boolean {
  return pages <= 8;
}
