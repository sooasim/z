'use client';
import { useId, useRef } from 'react';
import { useI18n } from '@/lib/i18n';
import { formatDate } from '@/lib/format';
import { MonthCalendar } from '@/components/calendar';
import { Icon, Modal, useFitPopover, useMediaQuery, usePopover } from '@/components/ui';
import s from './public.module.css';

/**
 * Single-date picker styled like a form field (label above, 46px control): the JETPOOL month calendar in a popover
 * (bottom sheet on phones) instead of the native `type=date` ("mm/dd/yyyy"). Past days are disabled.
 * TODO(design-system): promote to components/ui/pickers.tsx as `DateField`.
 */
export function DateField({ label, value, onChange, placeholder, hint, error, required, id }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; hint?: string; error?: string; required?: boolean; id?: string }) {
  const { L, lang } = useI18n();
  const p = usePopover();
  const gen = useId();
  const base = id ?? `df${gen.replace(/:/g, '')}`;
  const popRef = useRef<HTMLDivElement>(null);
  const phone = useMediaQuery('(max-width: 639px)');
  useFitPopover(p.open && !phone, popRef);
  const pick = (d: string) => {
    onChange(d);
    p.setOpen(false);
  };
  const cal = <MonthCalendar days={{}} selected={{ start: value }} onSelect={pick} legend={false} showPrices={false} />;
  const describedBy = [hint ? `${base}-h` : '', error ? `${base}-e` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={s.slotField}>
      <span className={s.lbl} id={`${base}-l`}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </span>
      <div className="popover-anchor" ref={p.ref}>
        <button
          type="button"
          id={base}
          className="search-slot"
          aria-haspopup="dialog"
          aria-expanded={p.open}
          aria-labelledby={`${base}-l ${base}-v`}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          onClick={() => p.setOpen(!p.open)}
          style={error ? { borderColor: 'var(--danger)' } : undefined}
        >
          <Icon name="calendar" size={18} />
          <span id={`${base}-v`} className={`v ${value ? '' : 'ph'}`}>
            {value ? formatDate(value, lang) : placeholder ?? L('날짜 선택', 'Choose a date')}
          </span>
        </button>
        {value && (
          <button type="button" className={`btn ghost icon sm ${s.clear}`} onClick={() => onChange('')} aria-label={L(`${label} 지우기`, `Clear ${label}`)}>
            <Icon name="close" size={16} />
          </button>
        )}
        {p.open && !phone && (
          <div ref={popRef} className={`popover ${s.datePop}`} role="dialog" aria-label={label}>
            {cal}
          </div>
        )}
        {phone && (
          <Modal
            open={p.open}
            onClose={() => p.setOpen(false)}
            panelRef={p.portalRef}
            title={label}
            footer={
              <>
                <button type="button" className="btn link sm" onClick={() => pick('')} disabled={!value}>
                  {L('지우기', 'Clear')}
                </button>
                <button type="button" className="btn primary" onClick={() => p.setOpen(false)}>
                  {L('완료', 'Done')}
                </button>
              </>
            }
          >
            {cal}
          </Modal>
        )}
      </div>
      {hint && (
        <small className="hint xs muted" id={`${base}-h`}>
          {hint}
        </small>
      )}
      {error && (
        <small className={`xs ${s.err}`} id={`${base}-e`}>
          {error}
        </small>
      )}
    </div>
  );
}
