'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Photo } from '@/components/media';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { items, item, str, f, num } from '@/lib/shape';
import { postcardFor } from '@/lib/art';
import { RequireAuth } from '@/components/gate';
import { StateView, EmptyState } from '@/components/states';
import { PropertyCard, GuideCard, ProductCard, realImages } from '@/components/cards';
import { useFavorites } from '@/components/favorites';
import { Button, ButtonLink, Checkbox, ErrorText, Icon, Input, Modal, PageHeader, Section } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { styles as s } from '@/components/traveler/ui';
import { useCachedApi } from '@/components/traveler/hooks';
import { visibilityLabel } from '@/components/traveler/labels';

type Target = 'PROPERTY' | 'GUIDE' | 'TRAVEL_PRODUCT';

/** Card for a favorite / collection item; resolves guides & products the favorites payload doesn't embed. */
function SavedCard({ fv, onAddTo }: { fv: any; onAddTo?: (t: Target, id: string) => void }) {
  const { L } = useI18n();
  const { has, toggle } = useFavorites();
  const t = str(fv, 'targetType').toUpperCase() as Target;
  const id = str(fv, 'targetId');
  const embedded = f<any>(fv, 'target', 'property', 'guide', 'product');
  const path = embedded ? null : t === 'GUIDE' ? `/v1/guides/${id}` : t === 'TRAVEL_PRODUCT' ? `/v1/travel-products/${id}` : `/v1/properties/${id}`;
  const fetched = useCachedApi<any>(path);
  const target = embedded ? { ...embedded, id } : item(fetched.data) ? { ...item(fetched.data), id } : null;
  const removed = !has(t, id);
  if (!target)
    return (
      <div className="lcard" aria-hidden={fetched.loading ? true : undefined}>
        <div className={`skeleton sk-media`} />
        {!fetched.loading && <p className="small muted">{L('더 이상 볼 수 없는 항목이에요.', 'This item is no longer available.')}</p>}
      </div>
    );
  return (
    <div className="stack" style={{ position: 'relative', minWidth: 0 }}>
      <div className={removed ? s.removed : undefined} style={{ minWidth: 0 }}>{t === 'GUIDE' ? <GuideCard g={{ ...target, guideId: id }} /> : t === 'TRAVEL_PRODUCT' ? <ProductCard p={target} /> : <PropertyCard p={target} />}</div>
      {str(fv, 'note') && <p className="xs muted" style={{ margin: 0 }}>“{str(fv, 'note')}”</p>}
      <div className="row" style={{ gap: 6 }}>
        {removed ? (
          <Button size="sm" icon="heart" onClick={() => toggle(t, id)}>
            {L('다시 저장', 'Undo')}
          </Button>
        ) : (
          onAddTo && (
            <Button size="sm" variant="ghost" icon="plus" onClick={() => onAddTo(t, id)}>
              {L('컬렉션에 추가', 'Add to collection')}
            </Button>
          )
        )}
        {removed && <span className="xs muted">{L('저장 목록에서 삭제했어요', 'Removed from saved')}</span>}
      </div>
    </div>
  );
}

function AddToCollection({ target, onClose, cols, onChanged }: { target: { t: Target; id: string } | null; onClose: () => void; cols: any[]; onChanged: () => void }) {
  const { L } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const add = async (cid: string, cname: string) => {
    if (!target) return;
    setBusy(cid);
    setErr(null);
    try {
      await post(`/v1/collections/${cid}/items`, { targetType: target.t, targetId: target.id });
      toast.show(L(`‘${cname}’에 추가했어요`, `Added to “${cname}”`));
      onChanged();
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal open={!!target} onClose={onClose} title={L('컬렉션에 추가', 'Add to collection')}>
      <div className="stack">
        {cols.length > 0 ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
            {cols.map((c) => (
              <li key={str(c, 'id')} className="card flat row between" style={{ padding: '10px 14px' }}>
                <div>
                  <strong>{str(c, 'name')}</strong>
                  <div className="xs muted">{L(`${num(c, 'itemCount') ?? 0}개 항목`, `${num(c, 'itemCount') ?? 0} items`)}</div>
                </div>
                <Button size="sm" variant="primary" loading={busy === str(c, 'id')} onClick={() => add(str(c, 'id'), str(c, 'name'))}>
                  {L('추가', 'Add')}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small" style={{ margin: 0 }}>{L('아직 컬렉션이 없어요. 새로 만들어 바로 추가해 보세요.', 'No collections yet. Create one below.')}</p>
        )}
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            setErr(null);
            try {
              const r = await post('/v1/collections', { name: name.trim(), visibility: 'PRIVATE' });
              const c = item(r);
              setName('');
              if (str(c, 'id')) await add(str(c, 'id'), str(c, 'name') || name);
            } catch (x) {
              setErr(x);
            }
          }}
        >
          <div className="grow">
            <Input label={L('새 컬렉션', 'New collection')} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={L('예: 제주 한달살기 후보', 'e.g. Jeju month-stay ideas')} />
          </div>
          <Button type="submit" style={{ alignSelf: 'flex-end' }} disabled={!name.trim()}>
            {L('만들고 추가', 'Create & add')}
          </Button>
        </form>
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}

function CollectionView({ id, onBack }: { id: string; onBack: () => void }) {
  const { L, lang } = useI18n();
  const st = useApi<any>(`/v1/collections/${id}`, { auth: true });
  const c = item(st.data);
  return (
    <Section
      title={str(c, 'name') || L('컬렉션', 'Collection')}
      actions={
        <Button size="sm" variant="ghost" icon="left" onClick={onBack}>
          {L('전체 저장 목록', 'All saved')}
        </Button>
      }
    >
      <p className="small muted" style={{ margin: 0 }}>
        {visibilityLabel(str(c, 'visibility'), lang)} · {L(`${(c?.items ?? []).length}개 항목`, `${(c?.items ?? []).length} items`)}
      </p>
      <StateView
        state={st}
        skeleton="cards"
        isEmpty={(d) => (item(d)?.items ?? []).length === 0}
        empty={
          <EmptyState illo="saved" title={L('아직 담긴 항목이 없어요', 'This collection is empty')}>
            {L('저장한 항목의 ‘컬렉션에 추가’를 눌러 담아 보세요.', 'Use “Add to collection” on any saved item.')}
          </EmptyState>
        }
      >
        {(d) => (
          <div className={`grid ${s.cardGrid}`}>
            {(item(d)?.items ?? []).map((x: any) => (
              <SavedCard key={`${str(x, 'targetType')}:${str(x, 'targetId')}`} fv={x} />
            ))}
          </div>
        )}
      </StateView>
    </Section>
  );
}

export default function SavedView() {
  const { L, lang } = useI18n();
  const sp = useSearchParams();
  const router = useRouter();
  const openId = sp.get('collection') ?? '';
  const favs = useApi<any>('/v1/favorites', { auth: true });
  const cols = useApi<any>('/v1/collections', { auth: true });
  const [name, setName] = useState('');
  const [isPublic, setPublic] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [adding, setAdding] = useState<{ t: Target; id: string } | null>(null);
  const toast = useToast();
  const [filter, setFilter] = useState<'ALL' | Target>('ALL');
  const favItems = items(favs.data);
  const counts = { ALL: favItems.length, PROPERTY: 0, GUIDE: 0, TRAVEL_PRODUCT: 0 } as Record<string, number>;
  favItems.forEach((x) => (counts[str(x, 'targetType').toUpperCase()] = (counts[str(x, 'targetType').toUpperCase()] ?? 0) + 1));
  const collectionList = items(cols.data);
  // Cover art for collection tiles: favorites in the collection are not listed, so use the city art of saved stays.
  const art = favItems
    .map((x) => realImages([str(x, 'target.coverUrl')])[0] || (str(x, 'target.city') ? postcardFor(str(x, 'target.city'), str(x, 'targetId')) : ''))
    .filter(Boolean);
  return (
    <RequireAuth>
      <PageHeader title={L('저장 목록', 'Saved')} subtitle={L('마음에 드는 숙소·가이드·여행 상품을 모아 두고 비교해 보세요.', 'Keep stays, guides and tours you like in one place.')} />
      {openId ? (
        <CollectionView id={openId} onBack={() => router.replace('/saved', { scroll: false })} />
      ) : (
        <>
          <Section
            title={L('찜한 항목', 'Favorites')}
            actions={
              favItems.length > 0 ? (
                <div className="chip-group" role="group" aria-label={L('종류', 'Type')}>
                  {(['ALL', 'PROPERTY', 'GUIDE', 'TRAVEL_PRODUCT'] as const)
                    .filter((k) => k === 'ALL' || counts[k] > 0)
                    .map((k) => (
                      <button key={k} type="button" className="chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>
                        {k === 'ALL' ? L('전체', 'All') : k === 'PROPERTY' ? L('숙소', 'Stays') : k === 'GUIDE' ? L('가이드', 'Guides') : L('여행 상품', 'Tours')} {counts[k]}
                      </button>
                    ))}
                </div>
              ) : undefined
            }
          >
            <StateView
              state={favs}
              skeleton="cards"
              isEmpty={(d) => items(d).length === 0}
              empty={
                <EmptyState illo="saved" title={L('아직 저장한 항목이 없어요', 'Nothing saved yet')} action={<ButtonLink variant="primary" href="/stay">{L('숙소 둘러보기', 'Browse stays')}</ButtonLink>}>
                  {L('숙소·가이드·상품의 하트를 눌러 저장하면 여기에 모여요.', 'Tap the heart on stays, guides or tours to save them here.')}
                </EmptyState>
              }
            >
              {(d) => (
                <div className={`grid ${s.cardGrid}`}>
                  {items(d)
                    .filter((x: any) => filter === 'ALL' || str(x, 'targetType').toUpperCase() === filter)
                    .map((fv: any) => (
                      <SavedCard key={`${str(fv, 'targetType')}:${str(fv, 'targetId')}`} fv={fv} onAddTo={(t, id) => setAdding({ t, id })} />
                    ))}
                </div>
              )}
            </StateView>
          </Section>
          <Section title={L('컬렉션', 'Collections')}>
            <StateView
              state={cols}
              isEmpty={(d) => items(d).length === 0}
              empty={
                <EmptyState illo="saved" title={L('컬렉션이 없어요', 'No collections yet')}>
                  {L('여행지별로 묶어 두면 일행과 비교하기 쉬워요. 아래에서 새 컬렉션을 만들어 보세요.', 'Group saves by trip to compare with friends. Create one below.')}
                </EmptyState>
              }
            >
              {(d) => (
                <ul className="grid" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {items(d).map((c: any, i: number) => {
                    const n = num(c, 'itemCount', 'count') ?? 0;
                    const imgs = art.length ? [art[i % art.length], art[(i + 1) % art.length], art[(i + 2) % art.length]] : [postcardFor(str(c, 'name'), str(c, 'id'))];
                    return (
                      <li key={str(c, 'id')}>
                        <button type="button" className={`card link ${s.collection}`} style={{ width: '100%', textAlign: 'left', font: 'inherit', cursor: 'pointer' }} onClick={() => router.push(`/saved?collection=${str(c, 'id')}`, { scroll: false })}>
                          <div className={s.collectionArt} aria-hidden="true">
                            {imgs.map((src, k) => (
                              <Photo key={k} src={src} seed={`${str(c, 'id')}:${k}`} alt="" sizes="120px" />
                            ))}
                          </div>
                          <div className={s.collectionBody}>
                            <strong style={{ display: 'block' }}>{str(c, 'name', 'title')}</strong>
                            <span className="small muted">
                              {L(`${n}개 항목`, `${n} item${n === 1 ? '' : 's'}`)} · <Icon name={str(c, 'visibility') === 'PUBLIC' ? 'globe' : 'lock'} size={13} style={{ display: 'inline', verticalAlign: '-2px' }} /> {visibilityLabel(str(c, 'visibility'), lang)}
                            </span>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </StateView>
            <form
              className="card stack"
              style={{ marginTop: 16 }}
              onSubmit={async (e) => {
                e.preventDefault();
                setErr(null);
                try {
                  await post('/v1/collections', { name: name.trim(), visibility: isPublic ? 'PUBLIC' : 'PRIVATE' });
                  toast.show(L('컬렉션을 만들었어요', 'Collection created'));
                  setName('');
                  cols.reload();
                } catch (x) {
                  setErr(x);
                }
              }}
            >
              <strong>{L('새 컬렉션 만들기', 'New collection')}</strong>
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <div className="grow">
                  <Input label={L('이름', 'Name')} value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder={L('예: 부산 주말 여행', 'e.g. Busan weekend')} />
                </div>
                <Button type="submit" variant="primary" icon="plus" disabled={!name.trim()}>
                  {L('만들기', 'Create')}
                </Button>
              </div>
              <Checkbox label={L('링크가 있는 사람에게 공개', 'Anyone with the link can view')} checked={isPublic} onChange={(e) => setPublic(e.target.checked)} />
              <ErrorText error={err} />
            </form>
          </Section>
        </>
      )}
      <AddToCollection target={adding} onClose={() => setAdding(null)} cols={collectionList} onChanged={cols.reload} />
    </RequireAuth>
  );
}
