'use client';
import { useEffect, useId, useRef, useState, type ReactNode, type DragEvent } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { f, item } from '@/lib/shape';
import { useI18n } from '@/lib/i18n';
import { toMinor, currencyExponent } from '@/lib/format';
import { fieldErrors } from '@/lib/errors';
import { StateView } from './states';
import { Alert, ErrorText, Icon } from './ui';
import type { Lang } from '@/lib/format';

export interface FieldSpec {
  name: string;
  label: string;
  type?: 'text' | 'email' | 'tel' | 'textarea' | 'number' | 'select' | 'checkbox' | 'date' | 'datetime-local' | 'money' | 'list' | 'json' | 'url';
  options?: Array<{ value: string; label: string }>;
  hint?: string;
  required?: boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  /** Span the whole form row (textarea/json/checkbox do by default). */
  full?: boolean;
  /** Unit shown inside the input on the right (e.g. '명', '분', '%'). */
  suffix?: string;
  /** Currency for money fields (default KRW). */
  currency?: string;
}

const CURRENCY_SIGN: Record<string, string> = { KRW: '₩', USD: '$', JPY: '¥', EUR: '€', GBP: '£' };

function groupDigits(v: string, lang: Lang = 'ko'): string {
  const raw = String(v ?? '').replace(/[^\d]/g, '');
  if (!raw) return '';
  return Number(raw).toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-US');
}

export function toFormValue(row: any, fs: FieldSpec): any {
  const v = f(row, fs.name);
  if (fs.type === 'checkbox') return Boolean(v);
  if (fs.type === 'money') {
    if (v === undefined || v === null || v === '' || !Number.isFinite(Number(v))) return '';
    const exp = currencyExponent(fs.currency || 'KRW');
    return exp === 0 ? groupDigits(String(Math.round(Number(v)))) : (Number(v) / 10 ** exp).toFixed(exp);
  }
  if (fs.type === 'list') return Array.isArray(v) ? v.join(', ') : v ?? '';
  if (fs.type === 'json') return v === undefined ? '' : JSON.stringify(v, null, 2);
  if (fs.type === 'date' && typeof v === 'string') return v.slice(0, 10);
  return v ?? '';
}

export function fromFormValue(v: any, fs: FieldSpec): any {
  if (fs.type === 'checkbox') return Boolean(v);
  if (v === '' || v === undefined) return undefined;
  if (fs.type === 'number') return Number(String(v).replace(/,/g, ''));
  if (fs.type === 'money') return toMinor(v, fs.currency || 'KRW');
  if (fs.type === 'list') return String(v).split(',').map((s) => s.trim()).filter(Boolean);
  if (fs.type === 'json') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/** Client-side checks the browser can't express (money/number digits, ranges, JSON). Returns field → message. */
export function validateFields(fields: FieldSpec[], values: Record<string, any>, lang: Lang = 'ko'): Record<string, string> {
  const out: Record<string, string> = {};
  const L = (ko: string, en: string) => (lang === 'ko' ? ko : en);
  for (const fs of fields) {
    const v = values[fs.name];
    if (v === '' || v === undefined || v === null || fs.type === 'checkbox') continue;
    if (fs.type === 'money' || fs.type === 'number') {
      const s = String(v).replace(/[\s,₩$¥€£]/g, '');
      if (!/^-?\d+(\.\d+)?$/.test(s)) {
        out[fs.name] = L('숫자만 입력해 주세요.', 'Numbers only.');
        continue;
      }
      const n = Number(s);
      if (fs.min !== undefined && n < fs.min) out[fs.name] = L(`${fs.min.toLocaleString()} 이상 입력해 주세요.`, `Must be at least ${fs.min}.`);
      else if (fs.max !== undefined && n > fs.max) out[fs.name] = L(`${fs.max.toLocaleString()} 이하로 입력해 주세요.`, `Must be at most ${fs.max}.`);
    } else if (fs.type === 'json') {
      try {
        JSON.parse(String(v));
      } catch {
        out[fs.name] = L('JSON 형식이 올바르지 않습니다.', 'Invalid JSON.');
      }
    }
  }
  return out;
}

export function Fields({ fields, values, onChange, errors }: { fields: FieldSpec[]; values: Record<string, any>; onChange: (name: string, v: any) => void; errors?: Record<string, string> }) {
  const { lang } = useI18n();
  return (
    <>
      {fields.map((fs) => {
        const id = `f-${fs.name.replace(/\W/g, '_')}`;
        const err = errors?.[fs.name];
        const describedBy = [fs.hint ? `${id}-h` : '', err ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined;
        const common = { id, name: fs.name, required: fs.required, placeholder: fs.placeholder, 'aria-invalid': err ? true : undefined, 'aria-describedby': describedBy };
        const v = values[fs.name] ?? (fs.type === 'checkbox' ? false : '');
        const full = fs.full ?? (fs.type === 'textarea' || fs.type === 'json' || fs.type === 'checkbox');
        if (fs.type === 'checkbox')
          return (
            <div key={fs.name} className={full ? 'full' : undefined}>
              <label className="check" htmlFor={id}>
                <input type="checkbox" {...common} checked={!!v} onChange={(e) => onChange(fs.name, e.target.checked)} />
                <span>
                  {fs.label}
                  {fs.hint && (
                    <small className="hint xs muted" id={`${id}-h`} style={{ display: 'block' }}>
                      {fs.hint}
                    </small>
                  )}
                </span>
              </label>
              {err && (
                <small className="err xs" id={`${id}-e`} style={{ color: 'var(--danger)', fontWeight: 600 }}>
                  {err}
                </small>
              )}
            </div>
          );
        const sign = CURRENCY_SIGN[(fs.currency || 'KRW').toUpperCase()] ?? (fs.currency || 'KRW').toUpperCase();
        const input =
          fs.type === 'textarea' || fs.type === 'json' ? (
            <textarea {...common} value={v} onChange={(e) => onChange(fs.name, e.target.value)} className={fs.type === 'json' ? 'mono' : undefined} />
          ) : fs.type === 'select' ? (
            <select {...common} value={v} onChange={(e) => onChange(fs.name, e.target.value)}>
              <option value="">—</option>
              {fs.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : fs.type === 'money' ? (
            <span className="input-affix">
              <span className="affix" aria-hidden="true">
                {sign}
              </span>
              <input
                {...common}
                type="text"
                inputMode="numeric"
                pattern="[0-9,]*"
                autoComplete="off"
                value={v}
                className={fs.suffix ? 'has-end' : undefined}
                onChange={(e) => onChange(fs.name, e.target.value)}
                onBlur={(e) => {
                  if (/^[\d,\s]+$/.test(e.target.value)) onChange(fs.name, groupDigits(e.target.value, lang));
                }}
              />
              {fs.suffix && <span className="affix end">{fs.suffix}</span>}
            </span>
          ) : fs.suffix ? (
            <span className="input-affix">
              <input {...common} type={fs.type === 'list' ? 'text' : fs.type || 'text'} inputMode={fs.type === 'number' ? 'numeric' : undefined} min={fs.min} max={fs.max} value={v} onChange={(e) => onChange(fs.name, e.target.value)} className="has-end" style={{ paddingLeft: 14 }} />
              <span className="affix end">{fs.suffix}</span>
            </span>
          ) : (
            <input {...common} type={fs.type === 'list' ? 'text' : fs.type || 'text'} inputMode={fs.type === 'number' ? 'numeric' : undefined} min={fs.min} max={fs.max} value={v} onChange={(e) => onChange(fs.name, e.target.value)} />
          );
        return (
          <label key={fs.name} className={`field ${full ? 'full' : ''}`} htmlFor={id}>
            <span>
              {fs.label}
              {fs.required && <span aria-hidden="true"> *</span>}
            </span>
            {input}
            {fs.hint && (
              <small className="hint" id={`${id}-h`}>
                {fs.hint}
              </small>
            )}
            {err && (
              <small className="err" id={`${id}-e`}>
                {err}
              </small>
            )}
          </label>
        );
      })}
    </>
  );
}

/**
 * Generic create/update form. `submit` receives the converted body.
 * Client checks (digits, ranges, JSON) and server 422 `problem.errors[{path,message}]` are shown inline on the
 * field (aria-invalid + aria-describedby) and focus moves to the first invalid field.
 * `bare` drops the card chrome (inside a Modal); `formId` lets a footer button submit with `form={formId}`;
 * `hideSubmit` hides the built-in submit row.
 */
export function FormCard({
  fields,
  initial,
  submit,
  submitLabel,
  title,
  cols = 1,
  after,
  resetOnSuccess,
  bare,
  formId,
  hideSubmit,
}: {
  fields: FieldSpec[];
  initial?: any;
  submit: (body: Record<string, any>) => Promise<unknown>;
  submitLabel?: string;
  title?: ReactNode;
  cols?: 1 | 2;
  after?: ReactNode;
  resetOnSuccess?: boolean;
  bare?: boolean;
  formId?: string;
  hideSubmit?: boolean;
}) {
  const { t, L, lang } = useI18n();
  const init = () => Object.fromEntries(fields.map((fs) => [fs.name, toFormValue(initial ?? {}, fs)]));
  const [values, setValues] = useState<Record<string, any>>(init);
  const [err, setErr] = useState<unknown>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  // Re-seed from server data when it arrives/changes, but never clobber what the user is typing.
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setValues(init());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initial ?? {})]);
  const focusFirstInvalid = () =>
    requestAnimationFrame(() => {
      const el = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.focus({ preventScroll: true });
      }
    });
  const names = new Set(fields.map((x) => x.name));
  const serverErrs = Object.fromEntries(Object.entries(fieldErrors(err, lang)).filter(([k]) => names.has(k)));
  const allErrors = { ...serverErrs, ...errors };
  return (
    <form
      ref={formRef}
      id={formId}
      className={bare ? 'stack' : 'card stack'}
      noValidate={false}
      onSubmit={async (e) => {
        e.preventDefault();
        const v = validateFields(fields, values, lang);
        setErrors(v);
        if (Object.keys(v).length) {
          setErr(null);
          focusFirstInvalid();
          return;
        }
        setBusy(true);
        setErr(null);
        setOk(false);
        try {
          const body: Record<string, any> = {};
          for (const fs of fields) {
            const fv = fromFormValue(values[fs.name], fs);
            if (fv !== undefined) {
              // support dotted names → nested objects
              const parts = fs.name.split('.');
              let o = body;
              parts.slice(0, -1).forEach((p) => (o = o[p] = o[p] ?? {}));
              o[parts[parts.length - 1]] = fv;
            }
          }
          await submit(body);
          setOk(true);
          dirty.current = false; // saved: later server refreshes may re-seed the form again
          if (resetOnSuccess) setValues(Object.fromEntries(fields.map((fs) => [fs.name, toFormValue({}, fs)])));
        } catch (x) {
          setErr(x);
          if (Object.keys(fieldErrors(x, lang)).some((k) => names.has(k))) focusFirstInvalid();
        } finally {
          setBusy(false);
        }
      }}
    >
      {title && <h2>{title}</h2>}
      <div className={`form-grid ${cols === 2 ? 'cols-2' : ''}`}>
        <Fields
          fields={fields}
          values={values}
          errors={allErrors}
          onChange={(n, v) => {
            dirty.current = true;
            setOk(false);
            setValues((s) => ({ ...s, [n]: v }));
            if (errors[n]) setErrors((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== n)));
          }}
        />
      </div>
      {!hideSubmit && (
        <div className="row">
          <button className="btn primary" disabled={busy} data-loading={busy ? 'true' : undefined}>
            {busy ? L('처리 중…', 'Saving…') : submitLabel ?? t('common.save')}
          </button>
          {ok && (
            <span className="badge ok" role="status">
              <Icon name="check" size={14} /> {L('저장됨', 'Saved')}
            </span>
          )}
        </div>
      )}
      <ErrorText error={err} />
      {after}
    </form>
  );
}

/** Load a resource then edit it with PATCH/PUT. */
export function ResourceForm({ path, savePath, method = 'PATCH', fields, title, cols, notice }: { path: string; savePath?: string; method?: 'PATCH' | 'PUT' | 'POST'; fields: FieldSpec[]; title?: ReactNode; cols?: 1 | 2; notice?: ReactNode }) {
  const st = useApi<any>(path, { auth: true });
  return (
    <StateView state={st}>
      {(d) => (
        <>
          {notice && <Alert>{notice}</Alert>}
          <FormCard
            title={title}
            cols={cols}
            fields={fields}
            initial={item(d) ?? {}}
            submit={async (body) => {
              const r = await api(savePath ?? path, { method, body });
              st.setData(r ?? body);
            }}
          />
        </>
      )}
    </StateView>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Styled file picker / drop zone (replaces the native "Choose file" control): drag & drop or click, type/size
 * validation with Korean messages, chips with remove buttons, optional per-file progress (0–100).
 */
export function FileDrop({
  label,
  files,
  onChange,
  accept = '.pdf,.jpg,.jpeg,.png',
  maxSizeMb = 10,
  multiple = true,
  maxFiles = 10,
  hint,
  progress,
  required,
  disabled,
  name,
}: {
  label: ReactNode;
  files: File[];
  onChange: (files: File[]) => void;
  accept?: string;
  maxSizeMb?: number;
  multiple?: boolean;
  maxFiles?: number;
  hint?: ReactNode;
  /** Upload progress by file name (0–100). */
  progress?: Record<string, number>;
  required?: boolean;
  disabled?: boolean;
  name?: string;
}) {
  const { L } = useI18n();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [err, setErr] = useState('');
  const exts = accept
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const typesLabel = exts.map((e) => e.replace(/^\./, '').replace(/^image\/\*$/, 'image').toUpperCase()).filter((x, i, a) => a.indexOf(x) === i && x !== 'JPEG').join('/');
  const okType = (file: File) => {
    const n = file.name.toLowerCase();
    return exts.some((e) => (e.startsWith('.') ? n.endsWith(e) : e.endsWith('/*') ? file.type.startsWith(e.slice(0, -1)) : file.type === e));
  };
  const add = (list: FileList | File[] | null) => {
    if (!list) return;
    const incoming = Array.from(list);
    const bad = incoming.find((x) => !okType(x));
    const big = incoming.find((x) => x.size > maxSizeMb * 1024 * 1024);
    if (bad) setErr(L(`${bad.name}: 허용되지 않는 형식입니다 (${typesLabel}).`, `${bad.name}: file type not allowed (${typesLabel}).`));
    else if (big) setErr(L(`${big.name}: ${maxSizeMb}MB 이하 파일만 올릴 수 있어요.`, `${big.name}: files must be ${maxSizeMb} MB or smaller.`));
    else setErr('');
    const good = incoming.filter((x) => okType(x) && x.size <= maxSizeMb * 1024 * 1024);
    const next = multiple ? [...files, ...good.filter((g) => !files.some((x) => x.name === g.name && x.size === g.size))] : good.slice(0, 1);
    if (next.length > maxFiles) setErr(L(`최대 ${maxFiles}개까지 올릴 수 있어요.`, `Up to ${maxFiles} files.`));
    onChange(next.slice(0, maxFiles));
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (!disabled) add(e.dataTransfer.files);
  };
  return (
    <div className="filedrop field">
      <span id={`${id}-l`}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </span>
      <label
        className="zone"
        htmlFor={id}
        data-drag={drag ? 'true' : undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        style={disabled ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}
      >
        <span className="ico" aria-hidden="true">
          <Icon name="upload" size={20} />
        </span>
        <strong>{L('파일을 끌어오거나 선택하세요', 'Drag files here or browse')}</strong>
        <span className="xs">{L(`${typesLabel}, ${maxSizeMb}MB 이하${multiple ? ` · 최대 ${maxFiles}개` : ''}`, `${typesLabel}, up to ${maxSizeMb} MB${multiple ? ` · max ${maxFiles}` : ''}`)}</span>
        <input
          ref={inputRef}
          id={id}
          name={name}
          type="file"
          className="sr-only"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          required={required && files.length === 0}
          aria-labelledby={`${id}-l`}
          aria-describedby={[hint ? `${id}-h` : '', err ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined}
          aria-invalid={err ? true : undefined}
          onChange={(e) => {
            add(e.target.files);
            e.target.value = '';
          }}
        />
      </label>
      {hint && (
        <small className="hint" id={`${id}-h`}>
          {hint}
        </small>
      )}
      {err && (
        <small className="err" id={`${id}-e`} role="alert">
          {err}
        </small>
      )}
      {files.length > 0 && (
        <ul className="files" aria-label={L('선택한 파일', 'Selected files')}>
          {files.map((file, i) => {
            const pct = progress?.[file.name];
            return (
              <li key={file.name + i}>
                <Icon name={/\.pdf$/i.test(file.name) ? 'doc' : 'image'} size={18} />
                <span className="name" title={file.name}>
                  {file.name}
                </span>
                <span className="size">{fmtSize(file.size)}</span>
                {pct !== undefined && (
                  <span className="progress" style={{ width: 80 }} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={L('업로드 진행률', 'Upload progress')}>
                    <span style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
                  </span>
                )}
                <button type="button" className="btn ghost icon sm" disabled={disabled} aria-label={L(`${file.name} 삭제`, `Remove ${file.name}`)} onClick={() => onChange(files.filter((_, k) => k !== i))}>
                  <Icon name="close" size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
