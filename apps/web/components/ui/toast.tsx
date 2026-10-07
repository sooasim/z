'use client';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface ToastItem {
  id: number;
  tone: 'ok' | 'error' | 'info';
  text: string;
  action?: { label: string; run: () => void };
}
interface ToastApi {
  show: (text: string, opts?: { tone?: ToastItem['tone']; action?: ToastItem['action']; ms?: number }) => void;
}
const Ctx = createContext<ToastApi>({ show: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<ToastItem[]>([]);
  const show = useCallback<ToastApi['show']>((text, opts = {}) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l.slice(-2), { id, text, tone: opts.tone ?? 'ok', action: opts.action }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), opts.ms ?? 4200);
  }, []);
  return (
    <Ctx.Provider value={{ show }}>
      {children}
      <div className="toasts" role="region" aria-live="polite" aria-label="Notifications">
        {list.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`} role={t.tone === 'error' ? 'alert' : 'status'}>
            <span className="t-ico" aria-hidden="true">{t.tone === 'error' ? '!' : t.tone === 'info' ? 'i' : '✓'}</span>
            <span>{t.text}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action?.run();
                  setList((l) => l.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
