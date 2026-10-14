import { describe, expect, it } from 'vitest';
import { RAIL_AUTOPLAY_MS, railNextPage, railNumbered, railPage, railPages, railPrevPage } from '@/lib/rail';

describe('railPages', () => {
  it('is one page when the row fits', () => {
    expect(railPages(1000, 1000)).toBe(1);
    expect(railPages(600, 1000)).toBe(1);
  });

  it('ignores sub-pixel overflow, which every grid produces', () => {
    // A row of four cards sized with calc() lands a pixel or two over; offering a second page there
    // gives a control that scrolls almost nothing.
    expect(railPages(1001, 1000)).toBe(1);
    expect(railPages(1002, 1000)).toBe(1);
    expect(railPages(1003, 1000)).toBe(2);
  });

  it('counts a partly filled last page', () => {
    expect(railPages(1500, 1000)).toBe(2); // half a viewport over
    expect(railPages(2000, 1000)).toBe(2); // exactly one viewport over
    expect(railPages(2100, 1000)).toBe(3); // just past it
  });

  it('scales to a long rail', () => {
    // 16 cards at four per viewport is the cap the rails slice to.
    expect(railPages(4000, 1000)).toBe(4);
    expect(railPages(16 * 250, 1000)).toBe(4);
  });

  it('survives a zero or negative width without dividing by it', () => {
    expect(railPages(0, 0)).toBe(1);
    expect(railPages(500, 0)).toBe(501);
    expect(railPages(-10, 1000)).toBe(1);
  });
});

describe('railPage', () => {
  const pages = railPages(4000, 1000); // 4

  it('reports the page the rail settled on', () => {
    expect(railPage(0, 1000, pages)).toBe(0);
    expect(railPage(1000, 1000, pages)).toBe(1);
    expect(railPage(3000, 1000, pages)).toBe(3);
  });

  it('rounds to the nearest page, because snap lands on card edges, not viewport multiples', () => {
    expect(railPage(400, 1000, pages)).toBe(0);
    expect(railPage(600, 1000, pages)).toBe(1);
    expect(railPage(1600, 1000, pages)).toBe(2);
  });

  it('clamps past the end, which a rubber-band swipe reaches', () => {
    expect(railPage(99_999, 1000, pages)).toBe(3);
    expect(railPage(-50, 1000, pages)).toBe(0);
  });

  it('clamps when the breakpoint shrank the page count under it', () => {
    // Was on page 3 of 4, then the window widened so everything fits: no page 3 to point at.
    expect(railPage(3000, 1000, 1)).toBe(0);
    expect(railPage(3000, 1000, 2)).toBe(1);
  });
});

describe('railNumbered', () => {
  it('numbers a short deck and dots a long one', () => {
    expect(railNumbered(2)).toBe(true);
    expect(railNumbered(8)).toBe(true);
    expect(railNumbered(9)).toBe(false);
  });
});

describe('railNextPage / railPrevPage', () => {
  it('steps through the deck', () => {
    expect(railNextPage(0, 4)).toBe(1);
    expect(railNextPage(2, 4)).toBe(3);
    expect(railPrevPage(3, 4)).toBe(2);
    expect(railPrevPage(1, 4)).toBe(0);
  });

  it('wraps at both ends, so autoplay keeps cycling and neither arrow dead-ends', () => {
    expect(railNextPage(3, 4)).toBe(0);
    expect(railPrevPage(0, 4)).toBe(3);
    expect(railNextPage(1, 2)).toBe(0);
    expect(railPrevPage(0, 2)).toBe(1);
  });

  it('stays put when there is nothing to page through', () => {
    expect(railNextPage(0, 1)).toBe(0);
    expect(railPrevPage(0, 1)).toBe(0);
    expect(railNextPage(0, 0)).toBe(0);
    expect(railPrevPage(0, 0)).toBe(0);
  });

  it('comes back into range from a page index the deck no longer has', () => {
    // A resize can shrink the deck between a tick being scheduled and it firing, so neither helper
    // may hand back a page that does not exist.
    expect(railNextPage(9, 3)).toBe(0);
    expect(railPrevPage(9, 3)).toBe(1);
    expect(railNextPage(-4, 3)).toBe(1);
    expect(railPrevPage(-4, 3)).toBe(2);
  });

  it('holds each page long enough to read, per the request for a 2-second slide', () => {
    expect(RAIL_AUTOPLAY_MS).toBe(2000);
  });
});
