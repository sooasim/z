'use client';
import Link from 'next/link';
import { Photo } from '@/components/media';
import { useId, useMemo, useState, type ReactNode, type KeyboardEvent } from 'react';
import { useI18n } from '@/lib/i18n';
import { Button, Icon, StatusPill, type IconName } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { encodeQr, qrPath } from './qr';
import { useCountdown } from './hooks';
import s from './traveler.module.css';

export { s as styles };

/** QR code rendered as inline SVG (dark modules on a white tile, so it scans in dark mode too). */
export function QrCode({ text, label, size = 196 }: { text: string; label: string; size?: number }) {
  const q = useMemo(() => {
    try {
      return qrPath(encodeQr(text));
    } catch {
      return null;
    }
  }, [text]);
  if (!q) return null;
  return (
    <div className={s.qr} style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${q.size} ${q.size}`} role="img" aria-label={label} shapeRendering="crispEdges">
        <rect width={q.size} height={q.size} fill="#fff" />
        <path d={q.d} fill="#0a1f36" />
      </svg>
    </div>
  );
}

/** Copy-to-clipboard button with toast feedback. */
export function CopyButton({ text, label, copied, size = 'sm', variant = 'default', icon = 'doc' }: { text: string; label: string; copied?: string; size?: 'sm' | 'md'; variant?: 'default' | 'ghost' | 'outline'; icon?: IconName }) {
  const { L } = useI18n();
  const toast = useToast();
  return (
    <Button
      size={size}
      variant={variant}
      icon={icon}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast.show(copied ?? L('복사했어요', 'Copied'), { tone: 'ok', ms: 2000 });
        } catch {
          toast.show(L('복사하지 못했어요. 직접 선택해 복사해 주세요.', 'Could not copy. Select and copy manually.'), { tone: 'error' });
        }
      }}
    >
      {label}
    </Button>
  );
}

/** Download a text file (recovery codes, .ics). */
export function downloadText(filename: string, text: string, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const icsEsc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
const icsDate = (d: string) => d.slice(0, 10).replace(/-/g, '');
const icsStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Build an iCalendar event: all-day when `start`/`end` are YYYY-MM-DD, timed otherwise. */
export function buildIcs(ev: { uid: string; title: string; start: string; end: string; location?: string; description?: string; url?: string }): string {
  const allDay = ev.start.length === 10;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//JETPOOL//Trips//KO',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${ev.uid}@jetpool`,
    `DTSTAMP:${icsStamp(new Date())}`,
    allDay ? `DTSTART;VALUE=DATE:${icsDate(ev.start)}` : `DTSTART:${icsStamp(new Date(ev.start))}`,
    allDay ? `DTEND;VALUE=DATE:${icsDate(ev.end)}` : `DTEND:${icsStamp(new Date(ev.end || ev.start))}`,
    `SUMMARY:${icsEsc(ev.title)}`,
    ev.location ? `LOCATION:${icsEsc(ev.location)}` : '',
    ev.description ? `DESCRIPTION:${icsEsc(ev.description)}` : '',
    ev.url ? `URL:${ev.url}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lines.join('\r\n');
}

export function CalendarButton({ event, filename, size = 'md', className }: { event: Parameters<typeof buildIcs>[0]; filename: string; size?: 'sm' | 'md'; className?: string }) {
  const { L } = useI18n();
  return (
    <Button size={size} icon="calendar" className={className} onClick={() => downloadText(filename, buildIcs(event), 'text/calendar;charset=utf-8')}>
      {L('캘린더에 추가', 'Add to calendar')}
    </Button>
  );
}

/** Neutral inline countdown ("11:49 남음") that turns amber under 3 minutes and red once expired. */
export function TimerChip({ expiresAt, children, expiredText }: { expiresAt: string | null | undefined; children?: (label: string) => ReactNode; expiredText?: string }) {
  const { L } = useI18n();
  const c = useCountdown(expiresAt);
  if (!c.valid) return null;
  const cls = c.expired ? s.expired : c.left < 180000 ? s.urgent : '';
  return (
    <span className={`${s.timer} ${cls}`} role="timer" aria-live="off">
      <Icon name="clock" size={16} />
      {c.expired ? expiredText ?? L('시간이 만료되었어요', 'Time expired') : children ? children(c.label) : L(`${c.label} 남음`, `${c.label} left`)}
    </span>
  );
}

export interface MilestoneStep {
  label: string;
  sub?: ReactNode;
}
/** Static vertical progress (done ✓ / current ● / upcoming ○). `current` = index of the active step; steps.length = all done. */
export function Milestones({ steps, current, label }: { steps: MilestoneStep[]; current: number; label: string }) {
  const { L } = useI18n();
  return (
    <ol className={s.miles} aria-label={label}>
      {steps.map((st, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'todo';
        return (
          <li key={st.label} className={s[state]} aria-current={state === 'current' ? 'step' : undefined}>
            <span className={s.dot} aria-hidden="true">
              {state === 'done' && <Icon name="check" size={14} strokeWidth={3} />}
            </span>
            <span className={s.lbl}>
              {st.label}
              <span className="sr-only">{state === 'done' ? L(' (완료)', ' (done)') : state === 'current' ? L(' (진행 중)', ' (in progress)') : L(' (예정)', ' (upcoming)')}</span>
              {st.sub && <span className={s.sub}>{st.sub}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export interface TripCardProps {
  href: string;
  image: string;
  title: string;
  meta: Array<ReactNode>;
  status?: string;
  statusLabels?: Record<string, string | [string, string]>;
  badge?: ReactNode;
  next?: { label: string; href: string; tone?: 'primary' | 'accent' | 'default' };
  code?: string;
  dimmed?: boolean;
}

/** Trip/booking card: cover, title, meta lines, status pill and one localized next action. */
export function TripCard({ href, image, title, meta, status, statusLabels, badge, next, code, dimmed }: TripCardProps) {
  return (
    <li className={`${s.tripCard} ${dimmed ? s.muted : ''}`}>
      <div className={s.tripMedia}>
        <Photo src={image} alt="" sizes="160px" />
      </div>
      <div className={s.tripBody}>
        <div className={s.tripTop}>
          <h3 className={s.tripTitle}>
            <Link href={href}>{title}</Link>
          </h3>
          {status && <StatusPill status={status} labels={statusLabels} />}
        </div>
        <p className={s.tripMeta}>
          {meta.filter(Boolean).map((m, i) => (
            <span key={i}>{m}</span>
          ))}
        </p>
        <div className={s.tripFoot}>
          <span className="row" style={{ gap: 8 }}>
            {badge}
            {code && <span className={s.tripCode}>{code}</span>}
          </span>
          {next && (
            <Link href={next.href} className={`btn sm ${next.tone === 'accent' ? 'accent' : next.tone === 'primary' ? 'primary' : ''} ${s.tripNext}`}>
              {next.label}
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}

/** Group of trip cards with a heading and count. */
export function TripGroup({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const id = useId();
  if (!count) return null;
  return (
    <section className={s.group} aria-labelledby={id}>
      <h2 id={id} className={s.groupHead}>
        {title} <span className={s.count}>{count}</span>
      </h2>
      <ul className={s.cards}>{children}</ul>
    </section>
  );
}

/** Accessible on/off switch (checkbox semantics). */
export function Switch({ checked, onChange, label, disabled, describedBy }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; describedBy?: string }) {
  return (
    <span className={s.switch}>
      <input type="checkbox" role="switch" aria-checked={checked} checked={checked} disabled={disabled} aria-label={label} aria-describedby={describedBy} onChange={(e) => onChange(e.target.checked)} />
      <span aria-hidden="true" />
    </span>
  );
}

/**
 * Tag input: type and press Enter / comma to add, Backspace on empty removes the last chip. `suggestions` render
 * as quick-add chips below. Values are stored as given (codes); `labelOf` maps them to display text.
 */
export function ChipsInput({ label, value, onChange, suggestions = [], labelOf = (v) => v, placeholder, hint, max = 12 }: { label: string; value: string[]; onChange: (v: string[]) => void; suggestions?: string[]; labelOf?: (v: string) => string; placeholder?: string; hint?: string; max?: number }) {
  const { L } = useI18n();
  const id = useId();
  const [text, setText] = useState('');
  const add = (raw: string) => {
    const v = raw.trim().replace(/,$/, '');
    if (!v || value.includes(v) || value.length >= max) return;
    onChange([...value, v]);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',') && !e.nativeEvent.isComposing) {
      e.preventDefault();
      add(text);
      setText('');
    } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
  };
  const rest = suggestions.filter((x) => !value.includes(x));
  return (
    <div className="field">
      <span id={`${id}-l`}>{label}</span>
      <div className={s.chipInput} onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
        {value.map((v) => (
          <span key={v} className={s.tag}>
            {labelOf(v)}
            <button type="button" aria-label={L(`${labelOf(v)} 삭제`, `Remove ${labelOf(v)}`)} onClick={() => onChange(value.filter((x) => x !== v))}>
              <Icon name="close" size={14} />
            </button>
          </span>
        ))}
        <input
          id={id}
          aria-labelledby={`${id}-l`}
          aria-describedby={hint ? `${id}-h` : undefined}
          value={text}
          placeholder={value.length ? '' : placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => {
            if (text.trim()) {
              add(text);
              setText('');
            }
          }}
        />
      </div>
      {hint && (
        <small className="hint" id={`${id}-h`}>
          {hint}
        </small>
      )}
      {rest.length > 0 && (
        <div className="chip-group" role="group" aria-label={L(`${label} 추천`, `Suggested ${label}`)} style={{ marginTop: 4 }}>
          {rest.slice(0, 10).map((x) => (
            <button key={x} type="button" className="chip" style={{ minHeight: 32, padding: '4px 12px' }} onClick={() => add(x)}>
              <Icon name="plus" size={14} /> {labelOf(x)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Card with a heading row (title + optional actions). */
export function InfoCard({ title, icon, actions, children, id }: { title: ReactNode; icon?: IconName; actions?: ReactNode; children: ReactNode; id?: string }) {
  const hid = useId();
  return (
    <section className={`card ${s.infoCard}`} aria-labelledby={hid} id={id}>
      <div className={s.cardHead}>
        <h2 id={hid} className="row" style={{ gap: 8 }}>
          {icon && <Icon name={icon} size={20} />}
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}
