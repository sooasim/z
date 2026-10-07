'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { api, post } from '@/lib/api';
import { items, str, f } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { StateView, EmptyState } from '@/components/states';
import { PropertyCard, GuideCard, ProductCard } from '@/components/cards';
import { ErrorText, PageHeader, Section, Checkbox } from '@/components/ui';

export default function SavedView() {
  const { L } = useI18n();
  const favs = useApi<any>('/v1/favorites', { auth: true });
  const cols = useApi<any>('/v1/collections', { auth: true });
  const [name, setName] = useState('');
  const [isPublic, setPublic] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <RequireAuth>
      <PageHeader title={L('저장 목록', 'Saved')} />
      <Section title={L('찜한 항목', 'Favorites')}>
        <StateView state={favs} isEmpty={(d) => items(d).length === 0} empty={<EmptyState title={L('아직 저장한 항목이 없어요.', 'Nothing saved yet.')}><p className="muted">{L('숙소·가이드·상품의 ♡ 버튼을 눌러 저장하세요.', 'Tap ♡ on stays, guides or products.')}</p></EmptyState>}>
          {(d) => (
            <div className="grid">
              {items(d).map((fv: any, i) => {
                const t = str(fv, 'targetType').toUpperCase();
                const target = f(fv, 'target', 'property', 'guide', 'product') ?? { id: str(fv, 'targetId'), title: str(fv, 'title') || str(fv, 'targetId').slice(0, 8) };
                return (
                  <div key={str(fv, 'id') || i} className="stack">
                    {t === 'GUIDE' ? <GuideCard g={target} /> : t === 'TRAVEL_PRODUCT' ? <ProductCard p={target} /> : <PropertyCard p={target} />}
                    <button
                      className="btn sm"
                      onClick={async () => {
                        try {
                          await api('/v1/favorites', { method: 'DELETE', query: { targetType: t, targetId: str(fv, 'targetId') } });
                          favs.reload();
                        } catch (e) {
                          setErr(e);
                        }
                      }}
                    >
                      {L('삭제', 'Remove')}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </StateView>
      </Section>
      <Section title={L('컬렉션', 'Collections')}>
        <form
          className="card row"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            try {
              await post('/v1/collections', { name, visibility: isPublic ? 'PUBLIC' : 'PRIVATE' });
              setName('');
              cols.reload();
            } catch (x) {
              setErr(x);
            }
          }}
        >
          <label className="field grow">
            <span>{L('새 컬렉션 이름', 'New collection')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
          </label>
          <Checkbox label={L('공개', 'Public')} checked={isPublic} onChange={(e) => setPublic(e.target.checked)} />
          <button className="btn primary">{L('만들기', 'Create')}</button>
        </form>
        <ErrorText error={err} />
        <StateView state={cols} isEmpty={(d) => items(d).length === 0} empty={<p className="muted">{L('컬렉션이 없습니다.', 'No collections.')}</p>}>
          {(d) => (
            <ul className="grid" style={{ listStyle: 'none', padding: 0 }}>
              {items(d).map((c: any) => (
                <li key={str(c, 'id')} className="card">
                  <h3>{str(c, 'name', 'title')}</h3>
                  <p className="small muted">
                    {str(c, 'itemCount', 'count') || 0} {L('개 항목', 'items')} · {str(c, 'visibility') || 'PRIVATE'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </StateView>
      </Section>
    </RequireAuth>
  );
}
