import { Fragment, type ReactNode } from 'react';
import s from './public.module.css';

/** Inline: **bold**, *em*, [label](/path or https://…). Everything else is plain text (no raw HTML is ever injected). */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<strong key={k++}>{m[1]}</strong>);
    else if (m[2]) out.push(<em key={k++}>{m[2]}</em>);
    else if (m[3]) {
      const href = m[4];
      const safe = href.startsWith('/') || /^https?:\/\//.test(href);
      out.push(safe ? <a key={k++} href={href} {...(href.startsWith('/') ? {} : { target: '_blank', rel: 'noopener noreferrer' })}>{m[3]}</a> : m[3]);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Small, safe Markdown renderer for CMS copy (stories, destinations, charter): ##/### headings, paragraphs,
 * - / 1. lists and > quotes. `baseLevel` shifts headings so a story body never competes with the page <h1>.
 */
export function Markdown({ source, compact, baseLevel = 2 }: { source: string; compact?: boolean; baseLevel?: 2 | 3 }) {
  const blocks = String(source || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  return (
    <div className={`${s.md} ${compact ? s.compact : ''}`}>
      {blocks.map((raw, i) => {
        const b = raw.trim();
        if (!b) return null;
        const h = /^(#{1,4})\s+(.*)$/.exec(b);
        if (h && !b.includes('\n')) {
          const lvl = Math.min(4, Math.max(baseLevel, h[1].length + (baseLevel - 2)));
          const H = `h${lvl}` as 'h2' | 'h3' | 'h4';
          return <H key={i}>{inline(h[2])}</H>;
        }
        const lines = b.split('\n');
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-*]\s+/, ''))}</li>)}</ul>;
        if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) return <ol key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>)}</ol>;
        if (lines.every((l) => /^>\s?/.test(l))) return <blockquote key={i}>{inline(lines.map((l) => l.replace(/^>\s?/, '')).join(' '))}</blockquote>;
        // A heading followed by text in the same block.
        if (h) {
          const lvl = Math.min(4, Math.max(baseLevel, h[1].length + (baseLevel - 2)));
          const H = `h${lvl}` as 'h2' | 'h3' | 'h4';
          return (
            <Fragment key={i}>
              <H>{inline(lines[0].replace(/^#+\s+/, ''))}</H>
              <p>{inline(lines.slice(1).join(' '))}</p>
            </Fragment>
          );
        }
        return <p key={i}>{lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l)}</Fragment>)}</p>;
      })}
    </div>
  );
}
