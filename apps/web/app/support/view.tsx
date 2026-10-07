'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { post } from '@/lib/api';
import { RequireAuth } from '@/components/gate';
import { ResourceTable } from '@/components/table';
import { FormCard } from '@/components/form';
import { PageHeader, Section } from '@/components/ui';
import { useAuth } from '@/lib/auth';

const FAQ = [
  { q: ['결제 후 예약이 확정되지 않았어요', 'I paid but my booking is not confirmed'], a: ['결제사 승인 후 서버에서 확정합니다. 몇 분 내 자동 반영되며, 승인되지 않은 결제는 자동 취소됩니다.', 'We confirm only after the PG approves. Unapproved payments are voided automatically.'] },
  { q: ['홈 맞교환은 숙박비가 없나요?', 'Is home exchange free?'], a: ['맞교환은 금전 거래 없이 서로의 집을 교환합니다. 플랫폼 이용료·보증 정책은 운영 정책에 따릅니다.', 'Exchanges are non-monetary between homes; platform fees/guarantees follow policy.'] },
  { q: ['전세기 좌석을 바로 예약할 수 있나요?', 'Can I book charter seats directly?'], a: ['현재는 수요 접수(상담 신청)만 가능합니다.', 'Currently lead requests only.'] },
];

export default function SupportView() {
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const [k, setK] = useState(0);
  const i = lang === 'ko' ? 0 : 1;
  return (
    <>
      <PageHeader title={L('고객센터', 'Help center')} actions={<><Link className="btn" href="/support/disputes">{L('분쟁·신고', 'Disputes & reports')}</Link><Link className="btn" href="/assistant">{L('AI 도우미', 'AI assistant')}</Link></>} />
      <Section title={L('자주 묻는 질문', 'FAQ')}>
        {FAQ.map((f) => (
          <details key={f.q[0]} className="card flat">
            <summary style={{ fontWeight: 700, cursor: 'pointer' }}>{f.q[i]}</summary>
            <p style={{ marginTop: 8 }}>{f.a[i]}</p>
          </details>
        ))}
      </Section>
      <RequireAuth>
        <Section title={L('문의하기', 'Contact us')}>
          <FormCard
            cols={2}
            resetOnSuccess
            fields={[
              { name: 'category', label: L('분류', 'Category'), type: 'select', required: true, options: [{ value: 'BOOKING', label: L('예약', 'Booking') }, { value: 'PAYMENT', label: L('결제/환불', 'Payment/refund') }, { value: 'EXCHANGE', label: L('맞교환', 'Exchange') }, { value: 'GUIDE', label: L('가이드', 'Guide') }, { value: 'ACCOUNT', label: L('계정', 'Account') }, { value: 'SAFETY', label: L('안전', 'Safety') }, { value: 'OTHER', label: L('기타', 'Other') }] },
              { name: 'subjectId', label: L('관련 예약/주문 번호 (선택)', 'Related booking id (optional)') },
              { name: 'subject', label: L('제목', 'Subject'), required: true },
              { name: 'description', label: L('내용', 'Description'), type: 'textarea', required: true },
            ]}
            submit={async (b) => {
              await post('/v1/support/cases', b, { idempotencyKey: true });
              setK(k + 1);
            }}
            submitLabel={L('문의 접수', 'Submit')}
          />
        </Section>
        <Section title={L('내 문의', 'My cases')}>
          <ResourceTable
            key={k}
            path={user ? '/v1/support/cases' : null}
            columns={[
              { key: 'subject|title', label: L('제목', 'Subject') },
              { key: 'category', label: L('분류', 'Category') },
              { key: 'status|state', label: L('상태', 'Status'), kind: 'status' },
              { key: 'createdAt', label: L('접수일', 'Opened'), kind: 'datetime' },
            ]}
            empty={<p className="muted">{L('문의 내역이 없습니다.', 'No cases.')}</p>}
          />
        </Section>
      </RequireAuth>
    </>
  );
}
