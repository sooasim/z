'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { arr, f, item, str } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { Alert, ErrorText, Section } from '@/components/ui';
import { ExchangeHeader, exchangeView } from '../../shared';

const DEFAULT_CHECKS = [
  { code: 'IDENTITY_VERIFIED', ko: '본인 확인 완료', en: 'Identity verified', href: '/verification' },
  { code: 'HOME_VERIFIED', ko: '집 소유/거주 권한 확인', en: 'Right to host verified', href: '/verification' },
  { code: 'PROFILE_COMPLETE', ko: '프로필·집 소개 작성', en: 'Profile & home details complete', href: '/account/profile' },
  { code: 'SAFETY_ACK', ko: '안전 수칙 확인', en: 'Safety guidelines acknowledged' },
  { code: 'CALENDAR_FREE', ko: '양측 일정 비어 있음', en: 'Both calendars free' },
];

export default function ExchangeVerificationView() {
  const { id } = useParams<{ id: string }>();
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const st = useApi<any>(`/v1/exchanges/${id}`, { auth: true });
  const [ack, setAck] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const run = async (path: string, body: any) => {
    setBusy(true);
    setErr(null);
    try {
      await post(`/v1/exchanges/${id}/${path}`, body);
      st.reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <RequireAuth>
      <StateView state={st}>
        {(d) => {
          const x = exchangeView(d);
          const v = f<any>(item(d), 'verification', 'checklist', 'gate') ?? {};
          const remote = arr(v, 'checks', 'items').length ? arr(v, 'checks', 'items') : arr(item(d), 'checks', 'checklist');
          const mine = user?.id === x.requesterId ? 'requester' : 'counterpart';
          const passed = (code: string) => {
            const r = remote.find((c: any) => str(c, 'code', 'key').toUpperCase() === code);
            if (!r) return undefined;
            const s = f(r, mine) ?? r;
            return f(s, 'passed', 'ok') === true || ['PASS', 'PASSED', 'OK', 'DONE'].includes(str(s, 'status').toUpperCase());
          };
          const myAck = Boolean(f(item(d), `${mine}SafetyAckAt`, `${mine}SafetyAck`, 'safetyAckedByMe')) || passed('SAFETY_ACK') === true;
          const rows = remote.length
            ? remote.map((c: any) => ({ code: str(c, 'code', 'key'), label: str(c, 'label', 'name') || str(c, 'code'), ok: f(c, 'passed', 'ok') === true || ['PASS', 'PASSED', 'OK', 'DONE'].includes(str(c, 'status').toUpperCase()), href: DEFAULT_CHECKS.find((dc) => dc.code === str(c, 'code').toUpperCase())?.href }))
            : DEFAULT_CHECKS.map((c) => ({ code: c.code, label: c[lang], ok: passed(c.code) ?? false, href: c.href }));
          return (
            <>
              <ExchangeHeader x={x} />
              <Section title={L('맞교환 검증 체크리스트', 'Verification checklist')}>
                <ul className="card stack" style={{ listStyle: 'none' }}>
                  {rows.map((r) => (
                    <li key={r.code} className="row between">
                      <span>
                        <span aria-hidden="true">{r.ok ? '✅' : '⬜'}</span> {r.label} <span className="sr-only">{r.ok ? L('완료', 'done') : L('미완료', 'pending')}</span>
                      </span>
                      {!r.ok && r.href && <Link className="btn sm" href={r.href}>{L('진행', 'Go')}</Link>}
                    </li>
                  ))}
                </ul>
              </Section>
              <Section title={L('안전 수칙', 'Safety guidelines')}>
                <div className="card stack">
                  <ul>
                    <li>{L('귀중품·개인 서류는 잠금 보관하거나 치워 주세요.', 'Lock away valuables and documents.')}</li>
                    <li>{L('비상 연락처, 가스·전기 차단 위치를 안내서에 적어 주세요.', 'Note emergency contacts and shut-off locations.')}</li>
                    <li>{L('플랫폼 밖 금전 거래(보증금 송금 등)를 요구받으면 즉시 신고하세요.', 'Report any request for off-platform money.')}</li>
                    <li>{L('도착/출발 시 집 상태 사진을 메시지에 남겨 주세요.', 'Share condition photos on arrival/departure.')}</li>
                  </ul>
                  {myAck ? (
                    <Alert tone="ok">{L('안전 수칙을 확인했습니다.', 'You acknowledged the safety guidelines.')}</Alert>
                  ) : (
                    <>
                      <label className="check">
                        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                        <span>{L('위 안전 수칙을 읽고 동의합니다.', 'I have read and agree to the safety guidelines.')}</span>
                      </label>
                      <button className="btn" disabled={!ack || busy} onClick={() => run('safety-ack', { version: x.version, acknowledged: true })}>{L('확인 제출', 'Acknowledge')}</button>
                    </>
                  )}
                </div>
              </Section>
              <div className="row" style={{ marginTop: 16 }}>
                <button className="btn primary" disabled={busy} onClick={() => run('verify', { version: x.version })}>{L('검증 요청/재평가', 'Run verification')}</button>
                <Link className="btn" href={`/exchange/${id}/agreement`}>{L('계약서로 →', 'Agreement →')}</Link>
              </div>
              <ErrorText error={err} />
            </>
          );
        }}
      </StateView>
    </RequireAuth>
  );
}
