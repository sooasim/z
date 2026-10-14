'use client';
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/ui';
import { railNumbered, railPage, railPages } from '@/lib/rail';

/**
 * Paging state for a horizontal `.rail`.
 *
 * A rail is a scroll-snap row, so "a page" is one viewport of it. The page count comes from how many
 * viewports the overflow spans rather than from the item count, because the number of visible cards
 * changes with the breakpoint (4 on desktop, ~2 at 640px, ~1 below).
 *
 * The current page is read back from `scrollLeft` instead of being tracked as intent, so the indicator
 * follows where the rail actually settled — after a snap, a drag, a trackpad swipe or a keyboard scroll,
 * not only after our own buttons.
 */
export function useRailPager(ref: React.RefObject<HTMLDivElement | null>) {
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const n = railPages(el.scrollWidth, el.clientWidth);
      setPages(n);
      setPage(railPage(el.scrollLeft, el.clientWidth, n));
    };

    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setPage(railPage(el.scrollLeft, el.clientWidth, railPages(el.scrollWidth, el.clientWidth))));
    };

    measure();
    el.addEventListener('scroll', onScroll, { passive: true });
    // Width changes with the breakpoint; children arrive after the fetch resolves. Both change the count.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const mo = new MutationObserver(measure);
    mo.observe(el, { childList: true });

    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [ref]);

  const go = useCallback(
    (i: number) => {
      const el = ref.current;
      if (!el) return;
      const target = Math.max(0, Math.min(i, pages - 1));
      const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      el.scrollTo({ left: target * el.clientWidth, behavior: reduce ? 'auto' : 'smooth' });
    },
    [ref, pages],
  );

  // `page` is already clamped where it is set; re-clamp for the frame after `pages` shrinks on resize.
  const clamped = Math.max(0, Math.min(page, pages - 1));
  return { page: clamped, pages, go, atStart: clamped <= 0, atEnd: clamped >= pages - 1 };
}

/**
 * Slide-style controls for a `.rail`: previous / next with the page positions between them, so the row
 * reads as a deck of slides rather than something you discover by dragging. Desktop only — a touch
 * device swipes, and the arrows would only cover cards.
 *
 * Numbers up to eight pages, dots beyond that, because a row of eleven numbers stops being scannable.
 * Renders nothing when everything already fits.
 */
export function RailPager({ target, label }: { target: React.RefObject<HTMLDivElement | null>; label?: string }) {
  const { L } = useI18n();
  const { page, pages, go, atStart, atEnd } = useRailPager(target);
  if (pages <= 1) return null;
  const numbered = railNumbered(pages);
  return (
    <div className="rail-pager" role="group" aria-label={label ?? L('목록 넘기기', 'Scroll list')}>
      <button type="button" className="btn icon sm" onClick={() => go(page - 1)} disabled={atStart} aria-label={L('이전', 'Previous')}>
        <Icon name="left" size={16} />
      </button>
      <div className={numbered ? 'rail-pages' : 'rail-dots'}>
        {Array.from({ length: pages }, (_, i) => (
          <button
            key={i}
            type="button"
            className={`rail-page${i === page ? ' on' : ''}`}
            aria-current={i === page ? 'true' : undefined}
            /* Numbered buttons read themselves; a dot has no text, so it needs the label. */
            aria-label={numbered ? undefined : L(`${i + 1}페이지`, `Page ${i + 1}`)}
            onClick={() => go(i)}
          >
            {numbered ? i + 1 : ''}
          </button>
        ))}
      </div>
      <button type="button" className="btn icon sm" onClick={() => go(page + 1)} disabled={atEnd} aria-label={L('다음', 'Next')}>
        <Icon name="right" size={16} />
      </button>
    </div>
  );
}
