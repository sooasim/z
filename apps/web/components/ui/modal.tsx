'use client';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/lib/i18n';
import { errorMessage } from '@/lib/errors';
import { formatMoney, toMinor } from '@/lib/format';
import { Icon, type IconName } from './icons';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function useFocusTrap(open: boolean, onClose: () => void, initialFocus?: 'first' | 'container') {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((n) => n.offsetParent !== null || n === document.activeElement);
    const auto = el?.querySelector<HTMLElement>('[data-autofocus]');
    (auto ?? (initialFocus === 'container' ? el : focusables().find((n) => !n.classList.contains('modal-close')) ?? focusables()[0] ?? el))?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Only the top-most dialog reacts (nested dialogs / sheets).
      const all = document.querySelectorAll('[data-dialog-layer]');
      if (all.length && all[all.length - 1] !== el?.closest('[data-dialog-layer]')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      if (prev && document.contains(prev)) prev.focus?.();
    };
  }, [open, initialFocus]);
  return ref;
}

function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

function assignRef<T>(r: Ref<T> | undefined, v: T | null) {
  if (!r) return;
  if (typeof r === 'function') r(v);
  else (r as { current: T | null }).current = v;
}

/**
 * Accessible modal dialog; renders as a bottom sheet on small screens (`sheet`, default). Esc / backdrop close,
 * focus trap, focus restore. `panelRef` receives the overlay element (lets popover owners treat it as "inside").
 */
export function Modal({ open, onClose, title, children, footer, wide, sheet = true, panelRef, className, describedBy, initialFocus }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; sheet?: boolean; panelRef?: Ref<HTMLDivElement>; className?: string; describedBy?: string; initialFocus?: 'first' | 'container' }) {
  const { L } = useI18n();
  const ref = useFocusTrap(open, onClose, initialFocus);
  const mounted = useMounted();
  const hid = useId();
  if (!open || !mounted) return null;
  return createPortal(
    <div ref={(n) => assignRef(panelRef, n)} data-dialog-layer="" className={`overlay ${sheet ? 'sheet-mobile' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`modal ${wide ? 'wide' : ''} ${className ?? ''}`} role="dialog" aria-modal="true" aria-labelledby={hid} aria-describedby={describedBy} tabIndex={-1}>
        <div className="modal-head">
          <h2 id={hid}>{title}</h2>
          <button type="button" className="btn ghost icon sm modal-close" onClick={onClose} aria-label={L('닫기', 'Close')}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Side drawer (mobile navigation). Slides in from the right, traps focus, closes on Esc / backdrop. */
export function Drawer({ open, onClose, title, children, side = 'right', id }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; side?: 'right' | 'left'; id?: string }) {
  const { L } = useI18n();
  const ref = useFocusTrap(open, onClose);
  const mounted = useMounted();
  const hid = useId();
  if (!open || !mounted) return null;
  return createPortal(
    <div data-dialog-layer="" className={`overlay drawer-overlay ${side}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} id={id} className="drawer" role="dialog" aria-modal="true" aria-labelledby={hid} tabIndex={-1}>
        <div className="drawer-head">
          <h2 id={hid}>{title}</h2>
          <button type="button" className="btn ghost icon sm modal-close" onClick={onClose} aria-label={L('닫기', 'Close')}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Extra input collected by a ConfirmDialog (role picker, refund amount …). */
export interface DialogField {
  name: string;
  label: string;
  type?: 'text' | 'textarea' | 'number' | 'money' | 'select' | 'checkbox' | 'checkboxes';
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  min?: number;
  max?: number;
  /** For money: currency of `max`/`defaultValue` (minor units). */
  currency?: string;
  hint?: string;
  placeholder?: string;
  defaultValue?: string | number | boolean | string[];
}

export interface ConfirmOptions {
  title: ReactNode;
  /** Consequence summary: what happens, refund preview, row context. */
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary' | 'accent';
  icon?: IconName;
  /** Ask for an audited reason. `true` uses a default label; a string is the label. */
  requireReason?: boolean | string;
  reasonMinLength?: number;
  reasonPlaceholder?: string;
  fields?: DialogField[];
}

type FieldValues = Record<string, any>;

function initialValues(fields: DialogField[] = []): FieldValues {
  const v: FieldValues = {};
  for (const f of fields) {
    if (f.type === 'checkbox') v[f.name] = Boolean(f.defaultValue);
    else if (f.type === 'checkboxes') v[f.name] = Array.isArray(f.defaultValue) ? f.defaultValue : [];
    else if (f.type === 'money') v[f.name] = f.defaultValue !== undefined && f.defaultValue !== '' ? String(f.defaultValue) : '';
    else v[f.name] = f.defaultValue ?? '';
  }
  return v;
}

/**
 * Styled replacement for window.confirm / window.prompt: consequence text, optional audited reason (min length,
 * inline Korean validation), optional extra fields, danger-tone confirm, busy state and inline API errors.
 * `onConfirm` may throw — the error is shown inside the dialog and it stays open.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  children,
  confirmLabel,
  cancelLabel,
  tone = 'primary',
  icon,
  requireReason,
  reasonMinLength = 5,
  reasonPlaceholder,
  fields,
}: ConfirmOptions & { open: boolean; onClose: () => void; onConfirm: (reason: string | undefined, values: FieldValues) => unknown | Promise<unknown>; children?: ReactNode }) {
  const { L, lang } = useI18n();
  const [reason, setReason] = useState('');
  const [values, setValues] = useState<FieldValues>(() => initialValues(fields));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const bid = useId();
  useEffect(() => {
    if (open) {
      setReason('');
      setValues(initialValues(fields));
      setTouched(false);
      setErr(null);
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const reasonLabel = typeof requireReason === 'string' ? requireReason : L('사유', 'Reason');
  const reasonErr = requireReason && reason.trim().length < reasonMinLength ? L(`사유를 ${reasonMinLength}자 이상 입력해 주세요.`, `Enter at least ${reasonMinLength} characters.`) : '';
  const fieldErr = (f: DialogField): string => {
    const v = values[f.name];
    if (f.type === 'checkboxes') return f.required && (!v || v.length === 0) ? L('하나 이상 선택해 주세요.', 'Choose at least one.') : '';
    if (f.type === 'checkbox') return f.required && !v ? L('확인이 필요합니다.', 'Required.') : '';
    const s = String(v ?? '').trim();
    if (!s) return f.required ? L('필수 항목입니다.', 'Required.') : '';
    if (f.type === 'number' || f.type === 'money') {
      if (!/^[\d,]+(\.\d+)?$/.test(s)) return L('숫자만 입력해 주세요.', 'Numbers only.');
      const n = f.type === 'money' ? toMinor(s, f.currency || 'KRW') : Number(s.replace(/,/g, ''));
      if (f.min !== undefined && n < f.min) return L(`${f.type === 'money' ? formatMoney(f.min, f.currency, 'ko') : f.min} 이상이어야 합니다.`, `Must be at least ${f.type === 'money' ? formatMoney(f.min, f.currency, 'en') : f.min}.`);
      if (f.max !== undefined && n > f.max) return L(`최대 ${f.type === 'money' ? formatMoney(f.max, f.currency, 'ko') : f.max}까지 가능합니다.`, `At most ${f.type === 'money' ? formatMoney(f.max, f.currency, 'en') : f.max}.`);
    }
    return '';
  };
  const invalid = !!reasonErr || (fields ?? []).some((f) => fieldErr(f));
  const submit = async () => {
    setTouched(true);
    if (invalid) {
      const first = document.querySelector<HTMLElement>(`[data-dialog="${bid}"] [aria-invalid="true"]`);
      first?.focus();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const out: FieldValues = {};
      for (const f of fields ?? []) {
        const v = values[f.name];
        out[f.name] = f.type === 'money' ? (String(v).trim() ? toMinor(String(v), f.currency || 'KRW') : undefined) : f.type === 'number' ? (String(v).trim() ? Number(String(v).replace(/,/g, '')) : undefined) : v;
      }
      await onConfirm(requireReason ? reason.trim() : undefined, out);
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const btn = tone === 'danger' ? 'danger' : tone === 'accent' ? 'accent' : 'primary';
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title={
        <span className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
          {(icon || tone === 'danger') && (
            <span className={`confirm-ico ${tone}`} aria-hidden="true">
              <Icon name={icon ?? 'alert-triangle'} size={18} />
            </span>
          )}
          <span>{title}</span>
        </span>
      }
      describedBy={body ? `${bid}-body` : undefined}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            {cancelLabel ?? L('취소', 'Cancel')}
          </button>
          <button type="button" className={`btn ${btn}`} onClick={submit} disabled={busy} data-loading={busy ? 'true' : undefined} aria-busy={busy || undefined}>
            {confirmLabel ?? L('확인', 'Confirm')}
          </button>
        </>
      }
    >
      <form
        className="stack"
        data-dialog={bid}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {body && (
          <div id={`${bid}-body`} className="small" style={{ color: 'var(--text-muted)' }}>
            {body}
          </div>
        )}
        {children}
        {(fields ?? []).map((f) => {
          const id = `${bid}-${f.name}`;
          const e = touched ? fieldErr(f) : '';
          const describe = [f.hint ? id + '-h' : '', e ? id + '-e' : ''].filter(Boolean).join(' ') || undefined;
          const set = (v: any) => setValues((s) => ({ ...s, [f.name]: v }));
          if (f.type === 'checkbox')
            return (
              <label key={f.name} className="check">
                <input type="checkbox" checked={!!values[f.name]} onChange={(ev) => set(ev.target.checked)} aria-invalid={!!e || undefined} />
                <span>{f.label}</span>
              </label>
            );
          if (f.type === 'checkboxes')
            return (
              <fieldset key={f.name} aria-describedby={describe}>
                <legend>{f.label}</legend>
                <div className="chip-group" style={{ marginTop: 6 }}>
                  {(f.options ?? []).map((o) => {
                    const on = (values[f.name] as string[]).includes(o.value);
                    return (
                      <button key={o.value} type="button" className="chip" aria-pressed={on} onClick={() => set(on ? values[f.name].filter((x: string) => x !== o.value) : [...values[f.name], o.value])}>
                        {on && <Icon name="check" size={14} />} {o.label}
                      </button>
                    );
                  })}
                </div>
                {f.hint && <small className="hint xs muted" id={id + '-h'}>{f.hint}</small>}
                {e && <small className="err xs" id={id + '-e'} style={{ color: 'var(--danger)', fontWeight: 600, display: 'block' }}>{e}</small>}
              </fieldset>
            );
          return (
            <label key={f.name} className="field" htmlFor={id}>
              <span>
                {f.label}
                {f.required && <span aria-hidden="true"> *</span>}
              </span>
              {f.type === 'textarea' ? (
                <textarea id={id} value={values[f.name]} placeholder={f.placeholder} onChange={(ev) => set(ev.target.value)} aria-invalid={!!e || undefined} aria-describedby={describe} />
              ) : f.type === 'select' ? (
                <select id={id} value={values[f.name]} onChange={(ev) => set(ev.target.value)} aria-invalid={!!e || undefined} aria-describedby={describe}>
                  <option value="">{L('선택하세요', 'Choose…')}</option>
                  {(f.options ?? []).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.type === 'money' ? (
                <span className="input-affix">
                  <span className="affix" aria-hidden="true">₩</span>
                  <input
                    id={id}
                    inputMode="numeric"
                    pattern="[0-9,]*"
                    value={values[f.name]}
                    placeholder={f.placeholder}
                    onChange={(ev) => set(ev.target.value)}
                    onBlur={(ev) => {
                      const raw = ev.target.value.replace(/[^\d]/g, '');
                      if (raw) set(Number(raw).toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-US'));
                    }}
                    aria-invalid={!!e || undefined}
                    aria-describedby={describe}
                  />
                </span>
              ) : (
                <input id={id} type="text" inputMode={f.type === 'number' ? 'numeric' : undefined} value={values[f.name]} placeholder={f.placeholder} onChange={(ev) => set(ev.target.value)} aria-invalid={!!e || undefined} aria-describedby={describe} />
              )}
              {f.hint && <small className="hint" id={id + '-h'}>{f.hint}</small>}
              {e && <small className="err" id={id + '-e'}>{e}</small>}
            </label>
          );
        })}
        {requireReason && (
          <label className="field" htmlFor={`${bid}-reason`}>
            <span>
              {reasonLabel} <span aria-hidden="true">*</span>
            </span>
            <textarea
              id={`${bid}-reason`}
              data-autofocus=""
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={reasonPlaceholder ?? L('처리 사유를 구체적으로 입력하세요. 감사 로그에 기록됩니다.', 'Describe the reason. It is recorded in the audit log.')}
              aria-invalid={touched && !!reasonErr ? true : undefined}
              aria-describedby={`${bid}-reason-h${touched && reasonErr ? ` ${bid}-reason-e` : ''}`}
              style={{ minHeight: 96 }}
            />
            <small className="hint" id={`${bid}-reason-h`}>
              {L(`${reasonMinLength}자 이상 · 감사 로그에 기록됩니다`, `At least ${reasonMinLength} characters · recorded in the audit log`)} ({reason.trim().length})
            </small>
            {touched && reasonErr && (
              <small className="err" id={`${bid}-reason-e`}>
                {reasonErr}
              </small>
            )}
          </label>
        )}
        {err ? (
          <div className="alert error" role="alert">
            <span className="ico" aria-hidden="true">
              <Icon name="alert-circle" size={20} />
            </span>
            <div className="grow">{errorMessage(err, lang)}</div>
          </div>
        ) : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

/**
 * Promise-based confirm: `const { confirm, dialog } = useConfirm();` render `{dialog}` once, then
 * `const r = await confirm({ title, body, tone: 'danger', requireReason: true }); if (!r.ok) return;`.
 * Pass `run` to execute the action inside the dialog (errors stay in the dialog): `await confirm({ ..., run: (reason) => api(...) })`.
 */
export function useConfirm() {
  const [state, setState] = useState<(ConfirmOptions & { run?: (reason: string | undefined, values: FieldValues) => unknown; resolve: (r: { ok: boolean; reason?: string; values?: FieldValues }) => void }) | null>(null);
  const confirm = useCallback(
    (opts: ConfirmOptions & { run?: (reason: string | undefined, values: FieldValues) => unknown }) =>
      new Promise<{ ok: boolean; reason?: string; values?: FieldValues }>((resolve) => setState({ ...opts, resolve })),
    [],
  );
  const resultRef = useRef<{ ok: boolean; reason?: string; values?: FieldValues } | null>(null);
  const dialog = state ? (
    <ConfirmDialog
      {...state}
      open
      onConfirm={async (reason, values) => {
        if (state.run) await state.run(reason, values);
        resultRef.current = { ok: true, reason, values };
      }}
      onClose={() => {
        state.resolve(resultRef.current ?? { ok: false });
        resultRef.current = null;
        setState(null);
      }}
    />
  ) : null;
  return { confirm, dialog };
}

/** Full-screen photo viewer with keyboard (←/→/Esc) and thumbnails. */
export function Lightbox({ images, index, onClose, title }: { images: string[]; index: number; onClose: () => void; title?: string }) {
  const { L } = useI18n();
  const [i, setI] = useState(index);
  const ref = useFocusTrap(true, onClose);
  const go = useCallback((d: number) => setI((x) => (x + d + images.length) % images.length), [images.length]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [go]);
  const mounted = useMounted();
  if (!mounted) return null;
  return createPortal(
    <div ref={ref} data-dialog-layer="" className="lightbox" role="dialog" aria-modal="true" aria-label={title ?? L('사진 보기', 'Photo viewer')} tabIndex={-1}>
      <div className="lb-bar">
        <button className="btn ghost sm" style={{ color: '#fff' }} onClick={onClose}>
          <Icon name="close" size={18} /> {L('닫기', 'Close')}
        </button>
        <span aria-live="polite" className="small">
          {i + 1} / {images.length}
        </span>
      </div>
      <div className="lb-stage">
        {images.length > 1 && (
          <button className="lb-arrow prev" onClick={() => go(-1)} aria-label={L('이전 사진', 'Previous')}>
            <Icon name="left" size={22} />
          </button>
        )}
        <img src={images[i]} alt={`${title ?? ''} ${i + 1}`} />
        {images.length > 1 && (
          <button className="lb-arrow next" onClick={() => go(1)} aria-label={L('다음 사진', 'Next')}>
            <Icon name="right" size={22} />
          </button>
        )}
      </div>
      <div className="lb-thumbs">
        {images.map((src, k) => (
          <button key={k} aria-current={k === i} onClick={() => setI(k)} aria-label={`${k + 1}`}>
            <img src={src} alt="" />
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
