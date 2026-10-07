'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { items, str } from '@/lib/shape';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useToast } from './ui/toast';

type Key = string; // `${type}:${id}`
interface FavCtx {
  has: (type: string, id: string) => boolean;
  toggle: (type: string, id: string) => Promise<void>;
  enabled: boolean;
}
const Ctx = createContext<FavCtx>({ has: () => false, toggle: async () => {}, enabled: false });

/** Optimistic favorites: UI flips immediately, reverts with a toast if the API rejects. */
export function FavoritesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { L } = useI18n();
  const toast = useToast();
  const [set, setSet] = useState<Set<Key>>(new Set());
  useEffect(() => {
    if (!user) {
      setSet(new Set());
      return;
    }
    api('/v1/favorites')
      .then((r) => setSet(new Set(items(r).map((f: any) => `${str(f, 'targetType').toUpperCase()}:${str(f, 'targetId')}`))))
      .catch(() => {});
  }, [user]);
  const has = useCallback((t: string, id: string) => set.has(`${t}:${id}`), [set]);
  const toggle = useCallback(
    async (t: string, id: string) => {
      const k = `${t}:${id}`;
      const was = set.has(k);
      setSet((s) => {
        const n = new Set(s);
        if (was) n.delete(k);
        else n.add(k);
        return n;
      });
      try {
        if (was) await api(`/v1/favorites/${t}/${id}`, { method: 'DELETE' });
        else await api('/v1/favorites', { method: 'POST', body: { targetType: t, targetId: id } });
        toast.show(was ? L('저장 목록에서 삭제했어요', 'Removed from saved') : L('저장 목록에 추가했어요', 'Saved'), { tone: 'ok', ms: 2400 });
      } catch {
        setSet((s) => {
          const n = new Set(s);
          if (was) n.add(k);
          else n.delete(k);
          return n;
        });
        toast.show(L('저장하지 못했어요. 다시 시도해 주세요.', 'Could not save. Try again.'), { tone: 'error' });
      }
    },
    [set, toast, L],
  );
  return <Ctx.Provider value={{ has, toggle, enabled: !!user }}>{children}</Ctx.Provider>;
}

export const useFavorites = () => useContext(Ctx);

export function HeartButton({ targetType, targetId, label }: { targetType: 'PROPERTY' | 'GUIDE' | 'TRAVEL_PRODUCT'; targetId: string; label?: string }) {
  const { has, toggle, enabled } = useFavorites();
  const { L } = useI18n();
  const on = has(targetType, targetId);
  return (
    <button
      type="button"
      className="heart"
      aria-pressed={on}
      aria-label={label ?? (on ? L('저장 취소', 'Unsave') : L('저장', 'Save'))}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!enabled) {
          window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
          return;
        }
        void toggle(targetType, targetId);
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 20s-7-4.4-9.2-8.6C1.3 8.4 3 5 6.4 5c2 0 3.3 1.1 4.1 2.3h3C14.3 6.1 15.6 5 17.6 5 21 5 22.7 8.4 21.2 11.4 19 15.6 12 20 12 20Z" />
      </svg>
    </button>
  );
}
