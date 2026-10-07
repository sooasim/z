'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { f, item } from '@/lib/shape';
import { useI18n } from '@/lib/i18n';
import { toMinor, currencyExponent } from '@/lib/format';
import { StateView } from './states';
import { Alert, ErrorText } from './ui';

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
}

export function toFormValue(row: any, fs: FieldSpec): any {
  const v = f(row, fs.name);
  if (fs.type === 'checkbox') return Boolean(v);
  if (fs.type === 'money') return v === undefined ? '' : String(Number(v) / 10 ** currencyExponent('KRW'));
  if (fs.type === 'list') return Array.isArray(v) ? v.join(', ') : v ?? '';
  if (fs.type === 'json') return v === undefined ? '' : JSON.stringify(v, null, 2);
  if (fs.type === 'date' && typeof v === 'string') return v.slice(0, 10);
  return v ?? '';
}

export function fromFormValue(v: any, fs: FieldSpec): any {
  if (fs.type === 'checkbox') return Boolean(v);
  if (v === '' || v === undefined) return undefined;
  if (fs.type === 'number') return Number(v);
  if (fs.type === 'money') return toMinor(v, 'KRW');
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

export function Fields({ fields, values, onChange }: { fields: FieldSpec[]; values: Record<string, any>; onChange: (name: string, v: any) => void }) {
  return (
    <>
      {fields.map((fs) => {
        const id = `f-${fs.name.replace(/\W/g, '_')}`;
        const common = { id, name: fs.name, required: fs.required, placeholder: fs.placeholder };
        const v = values[fs.name] ?? (fs.type === 'checkbox' ? false : '');
        if (fs.type === 'checkbox')
          return (
            <label key={fs.name} className="check" htmlFor={id}>
              <input type="checkbox" {...common} checked={!!v} onChange={(e) => onChange(fs.name, e.target.checked)} />
              <span>{fs.label}</span>
            </label>
          );
        return (
          <label key={fs.name} className="field" htmlFor={id}>
            <span>
              {fs.label}
              {fs.required && <span aria-hidden="true"> *</span>}
            </span>
            {fs.type === 'textarea' || fs.type === 'json' ? (
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
            ) : (
              <input
                {...common}
                type={fs.type === 'money' ? 'text' : fs.type === 'list' ? 'text' : fs.type || 'text'}
                inputMode={fs.type === 'money' || fs.type === 'number' ? 'numeric' : undefined}
                min={fs.min}
                max={fs.max}
                value={v}
                onChange={(e) => onChange(fs.name, e.target.value)}
              />
            )}
            {fs.hint && <small className="hint">{fs.hint}</small>}
          </label>
        );
      })}
    </>
  );
}

/** Generic create/update form. `submit` receives the converted body. */
export function FormCard({
  fields,
  initial,
  submit,
  submitLabel,
  title,
  cols = 1,
  after,
  resetOnSuccess,
}: {
  fields: FieldSpec[];
  initial?: any;
  submit: (body: Record<string, any>) => Promise<unknown>;
  submitLabel?: string;
  title?: ReactNode;
  cols?: 1 | 2;
  after?: ReactNode;
  resetOnSuccess?: boolean;
}) {
  const { t, L } = useI18n();
  const init = () => Object.fromEntries(fields.map((fs) => [fs.name, toFormValue(initial ?? {}, fs)]));
  const [values, setValues] = useState<Record<string, any>>(init);
  const [err, setErr] = useState<unknown>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  // Re-seed from server data when it arrives/changes, but never clobber what the user is typing.
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setValues(init());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initial ?? {})]);
  return (
    <form
      className="card stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        setOk(false);
        try {
          const body: Record<string, any> = {};
          for (const fs of fields) {
            const v = fromFormValue(values[fs.name], fs);
            if (v !== undefined) {
              // support dotted names → nested objects
              const parts = fs.name.split('.');
              let o = body;
              parts.slice(0, -1).forEach((p) => (o = o[p] = o[p] ?? {}));
              o[parts[parts.length - 1]] = v;
            }
          }
          await submit(body);
          setOk(true);
          dirty.current = false; // saved: later server refreshes may re-seed the form again
          if (resetOnSuccess) setValues(Object.fromEntries(fields.map((fs) => [fs.name, toFormValue({}, fs)])));
        } catch (x) {
          setErr(x);
        } finally {
          setBusy(false);
        }
      }}
    >
      {title && <h2>{title}</h2>}
      <div className={`form-grid ${cols === 2 ? 'cols-2' : ''}`}>
        <Fields fields={fields} values={values} onChange={(n, v) => { dirty.current = true; setValues((s) => ({ ...s, [n]: v })); }} />
      </div>
      <div className="row">
        <button className="btn primary" disabled={busy}>
          {busy ? L('처리 중…', 'Saving…') : submitLabel ?? t('common.save')}
        </button>
        {ok && <span className="badge ok">✓ {L('저장됨', 'Saved')}</span>}
      </div>
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
