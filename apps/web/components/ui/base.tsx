'use client';
import Link from 'next/link';
import { useId, type ReactNode, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { formatMoney, formatDate } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { errorMessage } from '@/lib/errors';
import { StatusPill } from './status';
import { Stepper } from './display';

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: string }) {
  const { t } = useI18n();
  return (
    <header className="page-head">
      {back && (
        <Link href={back} className="btn ghost sm" style={{ marginLeft: -10, marginBottom: 8 }}>
          ← {t('common.back')}
        </Link>
      )}
      <div className="row between" style={{ alignItems: 'flex-end' }}>
        <div className="grow">
          <h1 style={{ margin: 0 }}>{title}</h1>
          {subtitle && <p className="sub">{subtitle}</p>}
        </div>
        {actions && <div className="row">{actions}</div>}
      </div>
    </header>
  );
}

export function Section({ title, children, actions, id }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; id?: string }) {
  const hid = useId();
  return (
    <section aria-labelledby={title ? hid : undefined} id={id} className="stack section">
      {(title || actions) && (
        <div className="row between">
          {title && <h2 id={hid}>{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode };
export function Input({ label, hint, id, ...rest }: InputProps) {
  const gen = useId();
  const iid = id || gen;
  return (
    <label className="field" htmlFor={iid}>
      <span>
        {label} {rest.required && <span aria-hidden="true">*</span>}
      </span>
      <input id={iid} aria-describedby={hint ? iid + '-h' : undefined} {...rest} />
      {hint && (
        <small className="hint" id={iid + '-h'}>
          {hint}
        </small>
      )}
    </label>
  );
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { label: ReactNode; options: Array<{ value: string; label: string }> | string[] };
export function Select({ label, options, id, ...rest }: SelectProps) {
  const gen = useId();
  const iid = id || gen;
  return (
    <label className="field" htmlFor={iid}>
      <span>{label}</span>
      <select id={iid} {...rest}>
        {options.map((o) => {
          const opt = typeof o === 'string' ? { value: o, label: o } : o;
          return (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          );
        })}
      </select>
    </label>
  );
}

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { label: ReactNode; hint?: ReactNode };
export function Textarea({ label, hint, id, ...rest }: TextareaProps) {
  const gen = useId();
  const iid = id || gen;
  return (
    <label className="field" htmlFor={iid}>
      <span>{label}</span>
      <textarea id={iid} {...rest} />
      {hint && <small className="hint">{hint}</small>}
    </label>
  );
}

export function Checkbox({ label, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  );
}

export function Money({ minor, currency = 'KRW' }: { minor: number | string | undefined | null; currency?: string }) {
  const { lang } = useI18n();
  return <span>{formatMoney(minor ?? null, currency || 'KRW', lang)}</span>;
}

export function DateText({ value, time }: { value: string | undefined | null; time?: boolean }) {
  const { lang } = useI18n();
  return <time dateTime={value || undefined}>{formatDate(value || null, lang, time)}</time>;
}

export function StatusBadge({ status }: { status: string | undefined | null }) {
  return <StatusPill status={status} />;
}

export function Alert({ tone = 'info', children, role }: { tone?: 'info' | 'ok' | 'warn' | 'error'; children: ReactNode; role?: string }) {
  return (
    <div className={`alert ${tone}`} role={role ?? (tone === 'error' ? 'alert' : 'status')}>
      <span className="ico" aria-hidden="true">{tone === 'error' ? '⛔' : tone === 'warn' ? '⚠️' : tone === 'ok' ? '✅' : 'ℹ️'}</span>
      <div className="grow">{children}</div>
    </div>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  const { lang } = useI18n();
  if (!error) return null;
  return <Alert tone="error">{errorMessage(error, lang)}</Alert>;
}

export function Spinner({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div role="status" aria-live="polite" className="center" style={{ padding: 24 }}>
      <div className="spinner" aria-hidden="true" />
      <span className="muted small">{label ?? t('state.loading')}</span>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs, label }: { value: T; onChange: (v: T) => void; tabs: Array<{ value: T; label: string }>; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tb) => (
        <button key={tb.value} role="tab" type="button" aria-selected={value === tb.value} onClick={() => onChange(tb.value)}>
          {tb.label}
        </button>
      ))}
    </div>
  );
}

export function Kv({ rows }: { rows: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Steps({ steps, current }: { steps: string[]; current: number }) {
  return <Stepper steps={steps} current={current} />;
}

export function ChipGroup<T extends string>({ value, onChange, options, label, multi }: { value: T[]; onChange: (v: T[]) => void; options: Array<{ value: T; label: string }>; label: string; multi?: boolean }) {
  return (
    <div role="group" aria-label={label} className="chip-group">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            className="chip"
            aria-pressed={on}
            onClick={() => onChange(multi ? (on ? value.filter((v) => v !== o.value) : [...value, o.value]) : on ? [] : [o.value])}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
