'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { api, post } from '@/lib/api';
import { item, items, str, arr } from '@/lib/shape';
import { propertyView } from '@/lib/domain';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { FormCard } from '@/components/form';
import { Alert, ChipGroup, ErrorText, PageHeader, StatusPill, Tabs, Icon } from '@/components/ui';
import { useToast } from '@/components/ui/toast';

type Tab = 'basics' | 'location' | 'pricing' | 'rules';

function AmenityPicker({ propertyId, selected, onSaved }: { propertyId: string; selected: string[]; onSaved: () => void }) {
  const { L, lang } = useI18n();
  const toast = useToast();
  const cat = useApi<any>('/v1/amenities');
  const [sel, setSel] = useState<string[]>(selected);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const opts = items(cat.data).map((a: any) => ({ value: str(a, 'code'), label: lang === 'ko' ? str(a, 'labelKo', 'code') : str(a, 'labelEn', 'code') }));
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>{L('편의시설', 'Amenities')}</h2>
      {cat.loading ? <p className="muted">…</p> : <ChipGroup multi label={L('편의시설', 'Amenities')} value={sel} onChange={setSel} options={opts} />}
      <div className="row">
        <button
          className="btn primary"
          disabled={busy}
          data-loading={busy ? 'true' : undefined}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await api(`/v1/properties/${propertyId}/amenities`, { method: 'PUT', body: { codes: sel } });
              toast.show(L('편의시설을 저장했어요', 'Amenities saved'));
              onSaved();
            } catch (e) {
              setErr(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {L('저장', 'Save')}
        </button>
      </div>
      <ErrorText error={err} />
    </div>
  );
}

export default function ListingEditorView() {
  const { id } = useParams<{ id: string }>();
  const { L } = useI18n();
  const toast = useToast();
  const st = useApi<any>(`/v1/properties/${id}`, { auth: true });
  const [tab, setTab] = useState<Tab>('basics');
  const [err, setErr] = useState<unknown>(null);
  const [publishing, setPublishing] = useState(false);
  const pol = useApi<any>('/v1/properties/cancellation-policies');
  const policies = items(pol.data).map((c: any) => ({ value: str(c, 'code'), label: `${str(c, 'name') || str(c, 'code')}` }));
  const save = async (body: Record<string, unknown>) => {
    const r = await api(`/v1/properties/${id}`, { method: 'PATCH', body });
    st.setData(r ?? st.data);
    toast.show(L('저장했어요', 'Saved'));
  };
  return (
    <RequireAuth roles={['HOST']}>
      <StateView state={st} skeleton="detail">
        {(d) => {
          const p = item(d);
          const v = propertyView(p);
          const blockers = str(p, 'compliance.decision') === 'ALLOW' ? [] : arr<any>(p, 'compliance.reasons', 'publishBlockers');
          return (
            <>
              <PageHeader
                title={v.title}
                back="/host/listings"
                subtitle={<span className="row" style={{ gap: 8 }}><StatusPill status={v.status || 'DRAFT'} />{v.paidBookingEnabled && <span className="badge ok">✓ {L('유료 예약 가능', 'Paid booking on')}</span>} <span className="small">{L('변경 사항은 섹션별로 저장됩니다.', 'Each section saves separately.')}</span></span>}
                actions={
                  <>
                    <Link className="btn" href={`/host/listings/${id}/media`}>📷 {L('사진', 'Photos')}</Link>
                    <Link className="btn" href={`/host/listings/${id}/compliance`}>🛡 {L('인허가', 'Compliance')}</Link>
                    <button
                      className="btn accent"
                      disabled={publishing}
                      data-loading={publishing ? 'true' : undefined}
                      onClick={async () => {
                        setPublishing(true);
                        setErr(null);
                        try {
                          const r: any = await post(`/v1/properties/${id}/publish`, {});
                          const outcome = String(r?.outcome ?? '');
                          toast.show(outcome === 'PUBLISHED' ? L('게시되었어요!', 'Published!') : outcome === 'IN_REVIEW' ? L('준수 심사 대기 중이에요. 결과를 알려드릴게요.', 'Awaiting compliance review.') : L('게시 요청 완료', 'Publish requested'), { tone: outcome === 'DENIED' ? 'error' : 'ok' });
                          st.reload();
                        } catch (e) {
                          setErr(e);
                        } finally {
                          setPublishing(false);
                        }
                      }}
                    >
                      <Icon name="check" size={16} /> {L('게시하기', 'Publish')}
                    </button>
                  </>
                }
              />
              <ErrorText error={err} />
              {blockers.length > 0 && (
                <Alert tone="warn">
                  <strong>{L('게시/유료 예약 전 해결할 항목', 'Resolve before publishing / paid booking')}</strong>
                  <ul style={{ margin: '6px 0 0' }}>{blockers.map((b: any, i: number) => <li key={i}>{typeof b === 'string' ? b : str(b, 'message', 'code', 'label')}</li>)}</ul>
                </Alert>
              )}
              <Tabs label={L('편집 섹션', 'Sections')} value={tab} onChange={setTab} tabs={[{ value: 'basics', label: L('기본 정보', 'Basics') }, { value: 'location', label: L('위치', 'Location') }, { value: 'pricing', label: L('요금·예약', 'Pricing & booking') }, { value: 'rules', label: L('규칙·편의시설', 'Rules & amenities') }]} />
              <div style={{ marginTop: 16 }}>
                {tab === 'basics' && (
                  <FormCard cols={2} initial={p} submit={save} fields={[
                    { name: 'title', label: L('숙소 이름', 'Title'), required: true },
                    { name: 'propertyType', label: L('유형', 'Type'), type: 'select', options: ['APARTMENT', 'HOUSE', 'VILLA', 'HANOK', 'GUESTHOUSE', 'ROOM', 'STUDIO', 'OTHER'].map((t) => ({ value: t, label: t })) },
                    { name: 'roomType', label: L('공간 유형', 'Room type'), type: 'select', options: [{ value: 'ENTIRE', label: L('공간 전체', 'Entire place') }, { value: 'PRIVATE_ROOM', label: L('개인실', 'Private room') }, { value: 'SHARED_ROOM', label: L('다인실', 'Shared room') }] },
                    { name: 'maxGuests', label: L('최대 인원', 'Max guests'), type: 'number', min: 1, max: 50 },
                    { name: 'bedrooms', label: L('침실', 'Bedrooms'), type: 'number', min: 0 },
                    { name: 'beds', label: L('침대', 'Beds'), type: 'number', min: 0 },
                    { name: 'bathrooms', label: L('욕실 (0.5 단위)', 'Bathrooms (0.5 steps)'), type: 'number', min: 0 },
                    { name: 'summary', label: L('한 줄 요약', 'Summary') },
                    { name: 'description', label: L('소개 (게시하려면 50자 이상)', 'Description (50+ chars to publish)'), type: 'textarea' },
                  ]} />
                )}
                {tab === 'location' && (
                  <FormCard cols={2} initial={p} submit={save} fields={[
                    { name: 'address.line1', label: L('주소', 'Address'), hint: L('정확한 주소는 확정된 게스트에게만 공개됩니다.', 'Shared only with confirmed guests.'), required: true },
                    { name: 'address.line2', label: L('상세 주소', 'Address line 2') },
                    { name: 'address.publicAreaLabel', label: L('공개 지역명 (예: 애월읍 바닷가)', 'Public area label'), hint: L('검색·상세에 보이는 대략적 위치', 'Shown publicly instead of the address') },
                    { name: 'address.postalCode', label: L('우편번호', 'Postal code') },
                    { name: 'city', label: L('시/군', 'City'), required: true },
                    { name: 'region', label: L('지역 코드 (예: KR-49)', 'Region code'), placeholder: 'KR-49' },
                    { name: 'country', label: L('국가 코드', 'Country'), placeholder: 'KR' },
                    { name: 'timezone', label: L('시간대', 'Time zone'), placeholder: 'Asia/Seoul' },
                    { name: 'lat', label: L('위도 (선택)', 'Latitude (optional)'), type: 'number' },
                    { name: 'lng', label: L('경도 (선택)', 'Longitude (optional)'), type: 'number' },
                  ]} />
                )}
                {tab === 'pricing' && (
                  <FormCard cols={2} initial={{ ...p, cancellationPolicyCode: str(p, 'cancellationPolicy.code', 'cancellationPolicyCode') }} submit={save} fields={[
                    { name: 'basePriceMinor', label: L('기본 1박 요금 (원)', 'Base nightly rate (KRW)'), type: 'money' },
                    { name: 'cleaningFeeMinor', label: L('청소비 (원)', 'Cleaning fee (KRW)'), type: 'money' },
                    { name: 'minNights', label: L('최소 숙박일', 'Min nights'), type: 'number', min: 1 },
                    { name: 'maxNights', label: L('최대 숙박일', 'Max nights'), type: 'number', min: 1 },
                    { name: 'cancellationPolicyCode', label: L('환불 정책', 'Cancellation policy'), type: 'select', options: policies.length ? policies : [{ value: 'FLEXIBLE', label: 'FLEXIBLE' }, { value: 'MODERATE', label: 'MODERATE' }, { value: 'STRICT', label: 'STRICT' }] },
                    { name: 'checkInTime', label: L('체크인 시간', 'Check-in time'), placeholder: '15:00' },
                    { name: 'checkOutTime', label: L('체크아웃 시간', 'Check-out time'), placeholder: '11:00' },
                    { name: 'rentalEnabled', label: L('유료 숙박 판매 (인허가 통과 후 예약 가능)', 'Sell paid stays (bookable after compliance)'), type: 'checkbox' },
                    { name: 'exchangeEnabled', label: L('홈 맞교환 허용', 'Open to home exchange'), type: 'checkbox' },
                    { name: 'instantBook', label: L('즉시 예약', 'Instant book'), type: 'checkbox' },
                  ]} />
                )}
                {tab === 'rules' && (
                  <div className="stack-lg">
                    <AmenityPicker propertyId={id} selected={arr<any>(p, 'amenities').map((a) => (typeof a === 'string' ? a : str(a, 'code')))} onSaved={() => st.reload()} />
                    <FormCard cols={2} title={L('숙소 이용 규칙', 'House rules')} initial={p} submit={save} fields={[
                      { name: 'houseRules.smokingAllowed', label: L('흡연 가능', 'Smoking allowed'), type: 'checkbox' },
                      { name: 'houseRules.petsAllowed', label: L('반려동물 가능', 'Pets allowed'), type: 'checkbox' },
                      { name: 'houseRules.eventsAllowed', label: L('파티·행사 가능', 'Events allowed'), type: 'checkbox' },
                      { name: 'houseRules.quietHours', label: L('정숙 시간', 'Quiet hours'), placeholder: '22:00-08:00' },
                      { name: 'houseRules.extraRules', label: L('추가 규칙', 'Additional rules'), type: 'textarea' },
                    ]} />
                  </div>
                )}
              </div>
            </>
          );
        }}
      </StateView>
    </RequireAuth>
  );
}
