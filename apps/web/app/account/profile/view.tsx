'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { item, str, f } from '@/lib/shape';
import { fieldErrors } from '@/lib/errors';
import { presignedUpload, validateUpload } from '@/lib/media';
import { countryLabel } from '@/lib/places';
import { langName } from '@/lib/art';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { Avatar, Button, ChipGroup, ErrorText, Input, PageHeader, Select } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { useCachedApi } from '@/components/traveler/hooks';
import { styles as s } from '@/components/traveler/ui';
import type { Lang } from '@/lib/format';

const COUNTRIES = ['KR', 'JP', 'CN', 'TW', 'HK', 'SG', 'TH', 'VN', 'PH', 'ID', 'MY', 'US', 'CA', 'AU', 'NZ', 'GB', 'FR', 'DE', 'ES', 'IT', 'PT', 'NL'];
const TIMEZONES = ['Asia/Seoul', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Taipei', 'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Bangkok', 'Asia/Ho_Chi_Minh', 'Asia/Jakarta', 'Asia/Manila', 'Australia/Sydney', 'Pacific/Auckland', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Lisbon', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Pacific/Honolulu', 'UTC'];
const LANGS = ['ko', 'en', 'ja', 'zh', 'es', 'fr', 'de', 'it', 'pt', 'th', 'vi', 'id', 'ru'];
const BIO_MAX = 500;

function tzLabel(tz: string, lang: Lang): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date());
    const off = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    const city = tz === 'UTC' ? 'UTC' : tz.split('/').pop()!.replace(/_/g, ' ');
    const ko: Record<string, string> = { Seoul: '서울', Tokyo: '도쿄', Shanghai: '상하이', Taipei: '타이베이', 'Hong Kong': '홍콩', Singapore: '싱가포르', Bangkok: '방콕', 'Ho Chi Minh': '호치민', Jakarta: '자카르타', Manila: '마닐라', Sydney: '시드니', Auckland: '오클랜드', London: '런던', Paris: '파리', Berlin: '베를린', Lisbon: '리스본', New_York: '뉴욕', 'New York': '뉴욕', Chicago: '시카고', Denver: '덴버', 'Los Angeles': '로스앤젤레스', Honolulu: '호놀룰루' };
    return `${lang === 'ko' ? ko[city] ?? city : city} (${off.replace('GMT', 'GMT')})`;
  } catch {
    return tz;
  }
}

/** +821012345678 → 010-1234-5678 (Korean mobile), other E.164 numbers unchanged. */
export function displayPhone(e164: string): string {
  const d = (e164 || '').replace(/[^\d+]/g, '');
  const m = /^\+82(1\d)(\d{3,4})(\d{4})$/.exec(d);
  if (m) return `0${m[1]}-${m[2]}-${m[3]}`;
  return e164 || '';
}
/** 010-1234-5678 / 01012345678 → +821012345678; numbers starting with + are kept (digits only). */
export function toE164(input: string): string | null {
  const raw = (input || '').trim();
  if (!raw) return null;
  if (raw.startsWith('+')) return '+' + raw.slice(1).replace(/\D/g, '');
  const d = raw.replace(/\D/g, '');
  if (d.startsWith('82')) return '+' + d;
  if (d.startsWith('0')) return '+82' + d.slice(1);
  return '+82' + d;
}

function Form({ p, onSaved }: { p: any; onSaved: (x: any) => void }) {
  const { L, lang } = useI18n();
  const { reloadMe } = useAuth();
  const toast = useToast();
  const [v, setV] = useState(() => ({
    displayName: str(p, 'displayName'),
    preferredName: str(p, 'preferredName'),
    phone: displayPhone(str(p, 'phone')),
    country: str(p, 'country') || 'KR',
    timezone: str(p, 'timezone') || 'Asia/Seoul',
    languages: (f<string[]>(p, 'languages') ?? []) as string[],
    bio: str(p, 'bio'),
  }));
  const [avatarId, setAvatarId] = useState(str(p, 'avatarMediaId'));
  const [preview, setPreview] = useState('');
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [phoneErr, setPhoneErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const media = useCachedApi<any>(avatarId && !preview ? `/v1/media/${avatarId}` : null);
  const avatarUrl = preview || str(item(media.data), 'url', 'publicUrl', 'cdnUrl', 'variants.thumb', 'variants.small');
  const set = (k: keyof typeof v, val: any) => setV((x) => ({ ...x, [k]: val }));
  const fe = fieldErrors(err, lang);
  const countries = useMemo(() => COUNTRIES.map((c) => ({ value: c, label: countryLabel(c, lang) })).sort((a, b) => (a.value === 'KR' ? -1 : b.value === 'KR' ? 1 : a.label.localeCompare(b.label, lang))), [lang]);
  const timezones = useMemo(() => [...(v.timezone && !TIMEZONES.includes(v.timezone) ? [v.timezone] : []), ...TIMEZONES].map((tz) => ({ value: tz, label: tzLabel(tz, lang) })), [lang, v.timezone]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  return (
    <form
      className="card stack-lg"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        const phone = toE164(v.phone);
        if (phone && !/^\+[0-9]{8,15}$/.test(phone)) {
          setPhoneErr(L('휴대폰 번호 형식을 확인해 주세요. 예: 010-1234-5678', 'Check the number format, e.g. 010-1234-5678'));
          return;
        }
        setPhoneErr('');
        if (!v.displayName.trim()) return;
        setBusy(true);
        try {
          const body: Record<string, any> = {
            displayName: v.displayName.trim(),
            preferredName: v.preferredName.trim() || null,
            phone,
            country: v.country || null,
            timezone: v.timezone,
            languages: v.languages,
            bio: v.bio.trim() || null,
          };
          if (avatarId !== str(p, 'avatarMediaId')) body.avatarMediaId = avatarId || null;
          const r = await api('/v1/me/profile', { method: 'PATCH', body });
          onSaved(item(r) ?? r);
          await reloadMe();
          toast.show(L('프로필을 저장했어요', 'Profile saved'));
        } catch (x) {
          setErr(x);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className={s.avatarRow}>
        <Avatar name={v.displayName || '?'} src={avatarUrl || undefined} size={88} />
        <div className="stack" style={{ margin: 0 }}>
          <strong style={{ display: 'block' }}>{L('프로필 사진', 'Profile photo')}</strong>
          <span className="xs muted" style={{ display: 'block', maxWidth: 420 }}>{L('얼굴이 잘 보이는 사진은 호스트와 가이드의 신뢰를 높여요. JPG·PNG·WEBP, 15MB 이하', 'A clear photo builds trust with hosts and guides. JPG, PNG or WEBP up to 15 MB')}</span>
          <div className="row" style={{ gap: 8 }}>
            <Button size="sm" icon="camera" loading={uploading} onClick={() => fileRef.current?.click()}>
              {avatarUrl || avatarId ? L('사진 변경', 'Change photo') : L('사진 올리기', 'Upload photo')}
            </Button>
            {(avatarUrl || avatarId) && (
              <Button size="sm" variant="ghost" onClick={() => { setAvatarId(''); setPreview(''); }}>
                {L('삭제', 'Remove')}
              </Button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            aria-label={L('프로필 사진 선택', 'Choose a profile photo')}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              const bad = validateUpload(file);
              if (bad) {
                toast.show(bad === 'FILE_TOO_LARGE' ? L('15MB 이하 사진만 올릴 수 있어요', 'Photos must be 15 MB or smaller') : L('JPG·PNG·WEBP 사진만 올릴 수 있어요', 'Use a JPG, PNG or WEBP photo'), { tone: 'error' });
                return;
              }
              setUploading(true);
              try {
                const id = await presignedUpload(file, 'AVATAR');
                setAvatarId(id);
                setPreview(URL.createObjectURL(file));
                toast.show(L('사진을 올렸어요. 저장을 눌러 적용하세요.', 'Uploaded. Save to apply.'), { tone: 'info' });
              } catch (x) {
                setErr(x);
              } finally {
                setUploading(false);
              }
            }}
          />
        </div>
      </div>
      <div className="form-grid cols-2">
        <Input label={L('표시 이름', 'Display name')} required maxLength={80} value={v.displayName} onChange={(e) => set('displayName', e.target.value)} hint={L('예약·메시지에서 상대방에게 보이는 이름이에요.', 'Shown to hosts and guides.')} aria-invalid={fe.displayName ? true : undefined} />
        <Input label={L('불리고 싶은 이름 (선택)', 'Preferred name (optional)')} maxLength={80} value={v.preferredName} onChange={(e) => set('preferredName', e.target.value)} />
        <label className="field" htmlFor="phone">
          <span>{L('휴대폰 번호 (선택)', 'Mobile number (optional)')}</span>
          <span className={s.phone}>
            <span className={s.cc} aria-hidden="true">+82</span>
            <input id="phone" type="tel" inputMode="tel" autoComplete="tel-national" placeholder="010-1234-5678" value={v.phone} onChange={(e) => set('phone', e.target.value)} aria-describedby="phone-h" aria-invalid={phoneErr || fe.phone ? true : undefined} />
          </span>
          <small className="hint" id="phone-h">{L('알림톡·문자 알림과 본인 확인에 사용해요. 해외 번호는 +로 시작해 입력하세요.', 'Used for KakaoTalk/SMS alerts and verification. For non-Korean numbers start with +.')}</small>
          {(phoneErr || fe.phone) && <small className="err" role="alert">{phoneErr || fe.phone}</small>}
        </label>
        <Select label={L('거주 국가', 'Country of residence')} value={v.country} onChange={(e) => set('country', e.target.value)} options={countries} />
        <Select label={L('시간대', 'Time zone')} value={v.timezone} onChange={(e) => set('timezone', e.target.value)} options={timezones} />
        <div className="field">
          <span id="langs-l">{L('사용 언어', 'Languages you speak')}</span>
          <ChipGroup label={L('사용 언어', 'Languages')} multi value={v.languages} onChange={(x) => set('languages', x)} options={LANGS.map((c) => ({ value: c, label: langName(c, lang) }))} />
        </div>
        <label className="field full" htmlFor="bio">
          <span>{L('자기소개 (선택)', 'About you (optional)')}</span>
          <textarea id="bio" rows={5} maxLength={BIO_MAX} value={v.bio} onChange={(e) => set('bio', e.target.value)} aria-describedby="bio-c" placeholder={L('여행 스타일, 좋아하는 것, 호스트에게 알려 주고 싶은 점을 적어 보세요.', 'Your travel style, what you love, anything hosts should know.')} />
          <small id="bio-c" className={`${s.counter} ${v.bio.length >= BIO_MAX ? s.over : ''}`}>
            {v.bio.length}/{BIO_MAX}
          </small>
        </label>
      </div>
      <div className="row">
        <Button type="submit" variant="primary" loading={busy} disabled={!v.displayName.trim()}>
          {L('저장', 'Save')}
        </Button>
        <span className="xs muted">{L('변경 내역은 보안을 위해 기록돼요. 연락처는 예약이 확정된 상대에게만 공유돼요.', 'Changes are logged for security. Contact details are shared only with confirmed bookings.')}</span>
      </div>
      <ErrorText error={err} />
    </form>
  );
}

export default function ProfileView() {
  const { L } = useI18n();
  const st = useApi<any>('/v1/me/profile', { auth: true });
  return (
    <RequireAuth>
      <PageHeader title={L('프로필', 'Profile')} subtitle={L('호스트·게스트·가이드 화면에 함께 표시되는 정보예요.', 'Shown across host, guest and guide screens.')} />
      <StateView state={st}>{(d) => <Form p={item(d)} onSaved={(x) => st.setData({ item: x })} />}</StateView>
    </RequireAuth>
  );
}
