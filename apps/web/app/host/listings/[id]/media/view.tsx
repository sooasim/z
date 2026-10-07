'use client';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { api } from '@/lib/api';
import { arr, item, str } from '@/lib/shape';
import { presignedUpload, validateUpload } from '@/lib/media';
import { RequireAuth } from '@/components/gate';
import { StateView, EmptyState } from '@/components/states';
import { Alert, ErrorText, PageHeader, StatusPill, Icon } from '@/components/ui';
import { useToast } from '@/components/ui/toast';

interface Upload {
  name: string;
  pct: number;
  error?: string;
}

/** STAY-02: upload privately via presigned URL, then set the ordered media set with PUT /v1/properties/:id/media. */
export default function ListingMediaView() {
  const { id } = useParams<{ id: string }>();
  const { L } = useI18n();
  const toast = useToast();
  const prop = useApi<any>(`/v1/properties/${id}`, { auth: true });
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const [drag, setDrag] = useState(false);
  const [saving, setSaving] = useState(false);
  const rows = arr<any>(item(prop.data), 'media');
  const ids = rows.map((m: any) => str(m, 'id', 'mediaId'));

  const setOrder = async (next: Array<{ mediaId: string; caption?: string | null }>) => {
    setSaving(true);
    setErr(null);
    try {
      await api(`/v1/properties/${id}/media`, { method: 'PUT', body: { items: next } });
      prop.reload();
    } catch (e) {
      setErr(e);
    } finally {
      setSaving(false);
    }
  };
  const current = () => rows.map((m: any) => ({ mediaId: str(m, 'id', 'mediaId'), caption: str(m, 'caption') || null }));

  const handle = async (files: FileList | File[]) => {
    const added: string[] = [];
    for (const file of Array.from(files)) {
      const v = validateUpload(file);
      if (v) {
        setUploads((u) => [...u, { name: file.name, pct: 0, error: v === 'FILE_TOO_LARGE' ? L('15MB 초과', 'Over 15MB') : L('지원하지 않는 형식', 'Unsupported type') }]);
        continue;
      }
      setUploads((u) => [...u, { name: file.name, pct: 0 }]);
      try {
        const mid = await presignedUpload(file, 'PROPERTY', (pct) => setUploads((u) => u.map((x) => (x.name === file.name ? { ...x, pct } : x))));
        added.push(mid);
        setUploads((u) => u.map((x) => (x.name === file.name ? { ...x, pct: 100 } : x)));
      } catch (e) {
        setUploads((u) => u.map((x) => (x.name === file.name ? { ...x, error: (e as Error).message } : x)));
      }
    }
    if (added.length) {
      await setOrder([...current(), ...added.filter((a) => !ids.includes(a)).map((mediaId) => ({ mediaId }))]);
      toast.show(L('업로드 완료 — 검수·변환 후 공개됩니다', 'Uploaded — public after processing'));
    }
  };

  return (
    <RequireAuth roles={['HOST']}>
      <PageHeader title={L('사진 관리', 'Photos')} subtitle={str(item(prop.data), 'title')} back={`/host/listings/${id}`} />
      <label
        className="state"
        style={{ display: 'block', cursor: 'pointer', borderColor: drag ? 'var(--accent)' : undefined, background: drag ? 'var(--accent-soft)' : undefined }}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); void handle(e.dataTransfer.files); }}
      >
        <Icon name="plus" size={32} style={{ margin: '0 auto 8px' }} />
        <strong>{L('사진을 끌어다 놓거나 클릭해서 선택하세요', 'Drag photos here or click to choose')}</strong>
        <p className="small muted">{L('JPG · PNG · WebP · AVIF, 장당 15MB 이하. 게시하려면 최소 3장이 필요해요. 비공개 저장소에 올린 뒤 검수가 끝나면 공개됩니다.', 'JPG, PNG, WebP, AVIF up to 15MB. At least 3 photos to publish. Uploaded privately, public after moderation.')}</p>
        <input type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple className="sr-only" onChange={(e) => e.target.files && handle(e.target.files)} />
      </label>
      {uploads.length > 0 && (
        <ul className="stack" style={{ listStyle: 'none', padding: 0, marginTop: 16 }} aria-live="polite">
          {uploads.map((u) => (
            <li key={u.name} className="card flat">
              <div className="row between small"><span>{u.name}</span><span>{u.error ? <span className="badge danger">{u.error}</span> : `${u.pct}%`}</span></div>
              {!u.error && <div style={{ height: 6, background: 'var(--surface-3)', borderRadius: 6, marginTop: 6 }}><div style={{ width: `${u.pct}%`, height: '100%', background: 'var(--accent)', borderRadius: 6, transition: 'width var(--dur)' }} /></div>}
            </li>
          ))}
        </ul>
      )}
      <ErrorText error={err} />
      <div style={{ marginTop: 24 }}>
        <StateView state={prop} skeleton="cards" isEmpty={() => rows.length === 0} empty={<EmptyState illo="search" title={L('아직 사진이 없어요', 'No photos yet')}><p className="muted">{L('밝은 낮 시간대의 사진을 5장 이상 권장합니다.', 'We recommend 5+ bright daytime photos.')}</p></EmptyState>}>
          {() => (
            <div className="grid" aria-busy={saving}>
              {rows.map((m: any, i: number) => {
                const mid = str(m, 'id', 'mediaId');
                const url = str(m, 'publicUrl', 'url');
                return (
                  <figure key={mid} className="card" style={{ padding: 8, margin: 0 }}>
                    <div style={{ aspectRatio: '4 / 3', borderRadius: 'var(--r-md)', overflow: 'hidden', background: 'var(--surface-3)', display: 'grid', placeItems: 'center' }}>
                      {url ? <img src={url} alt={str(m, 'caption') || `${L('사진', 'Photo')} ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span className="small muted">{L('처리 중 · 비공개', 'Processing · private')}</span>}
                    </div>
                    <figcaption className="row between" style={{ marginTop: 8 }}>
                      <span className="row" style={{ gap: 6 }}>{i === 0 && <span className="badge accent">{L('대표', 'Cover')}</span>}<StatusPill status={str(m, 'moderationStatus') || str(m, 'status')} /></span>
                      <span className="row" style={{ gap: 4 }}>
                        {i > 0 && <button className="btn sm ghost" disabled={saving} onClick={() => { const c = current(); const [x] = c.splice(i, 1); void setOrder([x, ...c]); }}>{L('대표로', 'Make cover')}</button>}
                        {i > 0 && <button className="btn sm ghost icon" disabled={saving} aria-label={L('앞으로', 'Move earlier')} onClick={() => { const c = current(); [c[i - 1], c[i]] = [c[i], c[i - 1]]; void setOrder(c); }}>‹</button>}
                        <button className="btn sm ghost icon" disabled={saving} aria-label={L('삭제', 'Remove')} onClick={() => { if (window.confirm(L('이 사진을 숙소에서 제거할까요?', 'Remove this photo from the listing?'))) void setOrder(current().filter((x) => x.mediaId !== mid)); }}><Icon name="close" size={14} /></button>
                      </span>
                    </figcaption>
                  </figure>
                );
              })}
            </div>
          )}
        </StateView>
      </div>
      <Alert tone="info">{L('얼굴·차량번호 등 개인정보가 보이는 사진은 검수 과정에서 반려될 수 있어요.', 'Photos showing personal data (faces, plates) may be rejected in moderation.')}</Alert>
    </RequireAuth>
  );
}
