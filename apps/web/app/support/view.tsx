'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { items, str } from '@/lib/shape';
import { fieldErrors } from '@/lib/errors';
import { RequireAuth } from '@/components/gate';
import { EmptyState, StateView } from '@/components/states';
import { DataTable } from '@/components/table';
import { Button, ButtonLink, ErrorText, Icon, Input, PageHeader, Section } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { SubjectPicker, type Subject } from '@/components/traveler/SubjectPicker';
import { styles as s } from '@/components/traveler/ui';
import { SUPPORT_CATEGORY_LABEL, subjectLabel } from '@/components/traveler/labels';

const FAQ: Array<{ q: [string, string]; a: [string, string] }> = [
  { q: ['결제했는데 예약이 확정되지 않았어요', 'I paid but my booking isn’t confirmed'], a: ['결제사 승인을 받은 뒤 서버에서 확정해요. 보통 몇 분 안에 반영되며, 승인되지 않은 결제는 자동으로 취소돼요. 내 여행에서 상태를 확인해 보세요.', 'We confirm once the payment provider approves. It usually takes a few minutes; unapproved payments are voided automatically. Check My trips.'] },
  { q: ['예약을 취소하면 얼마나 환불되나요?', 'How much do I get back if I cancel?'], a: ['숙소마다 정한 취소 정책에 따라 달라요. 내 여행 › 예약 관리에서 지금 취소하면 받을 수 있는 예상 환불액을 바로 확인할 수 있어요.', 'It depends on the listing’s policy. My trips › Manage shows the exact refund if you cancel now.'] },
  { q: ['홈 맞교환에는 숙박비가 없나요?', 'Is a home exchange free?'], a: ['맞교환은 서로의 집을 바꿔 머무는 방식이라 숙박비를 주고받지 않아요. 플랫폼 이용료와 보증 정책은 운영 정책을 따릅니다.', 'Exchanges swap homes without paying for the stay. Platform fees and guarantees follow our policy.'] },
  { q: ['호스트에게 연락처를 알려줘도 되나요?', 'Can I share my phone number with a host?'], a: ['안전을 위해 예약이 확정되기 전에는 연락처 공유와 외부 결제 유도가 제한돼요. 모든 대화는 JETPOOL 메시지로 해 주세요.', 'For your safety, contact details and off-platform payments are restricted before a booking is confirmed. Keep chats in JETPOOL messages.'] },
  { q: ['전세기 좌석을 바로 예약할 수 있나요?', 'Can I book charter seats directly?'], a: ['현재는 수요 접수(상담 신청)만 가능해요. 전세기 JETPOOL 페이지에서 희망 일정을 남겨 주세요.', 'Currently we take requests only. Leave your preferred dates on the Charter page.'] },
];

function ContactForm({ onSent }: { onSent: () => void }) {
  const { L, lang } = useI18n();
  const sp = useSearchParams();
  const toast = useToast();
  const [category, setCategory] = useState(sp.get('topic') === 'supplier' ? 'OTHER' : '');
  const [subj, setSubj] = useState<Subject>({ type: (sp.get('subjectType') as Subject['type']) || '', id: sp.get('subjectId') ?? '' });
  const [subject, setSubject] = useState('');
  const [desc, setDesc] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const fe = fieldErrors(err, lang);
  const errs = {
    category: !category ? L('분류를 선택해 주세요.', 'Choose a category.') : '',
    subject: subject.trim().length < 3 ? L('제목을 3자 이상 입력해 주세요.', 'Enter at least 3 characters.') : '',
    description: !desc.trim() ? L('내용을 입력해 주세요.', 'Describe the issue.') : '',
  };
  const invalid = Object.values(errs).some(Boolean);
  return (
    <form
      className="card stack"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setTouched(true);
        if (invalid) {
          requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-support] [aria-invalid="true"]')?.focus());
          return;
        }
        setBusy(true);
        setErr(null);
        try {
          await post('/v1/support/cases', { category, subject: subject.trim(), description: desc.trim(), ...(subj.id ? { contextType: subj.type, contextId: subj.id } : {}) });
          toast.show(L('문의를 접수했어요. 답변은 알림과 이메일로 알려드려요.', 'Request received. We’ll reply by notification and email.'));
          setSubject('');
          setDesc('');
          setTouched(false);
          onSent();
        } catch (x) {
          setErr(x);
        } finally {
          setBusy(false);
        }
      }}
      data-support=""
    >
      <div className="form-grid cols-2">
        <label className="field" htmlFor="sc-cat">
          <span>
            {L('분류', 'Category')} <span aria-hidden="true">*</span>
          </span>
          <select id="sc-cat" value={category} onChange={(e) => setCategory(e.target.value)} required aria-invalid={touched && errs.category ? true : undefined} aria-describedby={touched && errs.category ? 'sc-cat-e' : undefined}>
            <option value="">{L('선택하세요', 'Choose…')}</option>
            {Object.entries(SUPPORT_CATEGORY_LABEL).map(([v, [ko, en]]) => (
              <option key={v} value={v}>
                {lang === 'ko' ? ko : en}
              </option>
            ))}
          </select>
          {touched && errs.category && <small className="err" id="sc-cat-e">{errs.category}</small>}
        </label>
        <div>
          <Input label={L('제목', 'Subject')} required maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} aria-invalid={touched && (errs.subject || fe.subject) ? true : undefined} placeholder={L('예: 체크인 시간 변경 문의', 'e.g. Changing my check-in time')} />
          {touched && errs.subject && <small className="err" style={{ display: 'block', marginTop: 4 }}>{errs.subject}</small>}
        </div>
        <div className="full">
          <SubjectPicker label={L('관련 예약 (선택)', 'Related booking (optional)')} optional value={subj} onChange={setSubj} hint={L('예약을 고르면 담당자가 내용을 더 빨리 확인할 수 있어요.', 'Picking a booking helps us help you faster.')} />
        </div>
        <label className="field full" htmlFor="sc-desc">
          <span>
            {L('내용', 'Details')} <span aria-hidden="true">*</span>
          </span>
          <textarea id="sc-desc" rows={6} maxLength={10000} value={desc} onChange={(e) => setDesc(e.target.value)} aria-invalid={touched && errs.description ? true : undefined} placeholder={L('언제, 어떤 문제가 있었는지 자세히 적어 주세요.', 'Tell us what happened and when.')} />
          {touched && errs.description && <small className="err">{errs.description}</small>}
        </label>
      </div>
      <div className="row">
        <Button type="submit" variant="primary" icon="mail" loading={busy}>
          {L('문의 접수', 'Send request')}
        </Button>
        <span className="xs muted">{L('보통 1영업일 안에 답변드려요.', 'We usually reply within one business day.')}</span>
      </div>
      <ErrorText error={err} />
    </form>
  );
}

function MyCases() {
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const st = useApi<any>(user ? '/v1/support/cases' : null, { auth: true, query: { limit: 50 } });
  return (
    <StateView
      state={st}
      skeleton="table"
      isEmpty={(d) => items(d).length === 0}
      empty={
        <EmptyState illo="messages" title={L('아직 문의한 내역이 없어요', 'No requests yet')}>
          {L('위 양식으로 문의하면 진행 상황을 여기서 확인할 수 있어요.', 'Requests you send appear here with their status.')}
        </EmptyState>
      }
    >
      {(d) => (
        <DataTable
          rows={items(d)}
          caption={L('내 문의', 'My requests')}
          filterable={false}
          paged={false}
          columns={[
            { key: 'subject|title', label: L('제목', 'Subject'), primary: true, render: (r) => <strong>{str(r, 'subject', 'title')}</strong> },
            { key: 'category', label: L('분류', 'Category'), render: (r) => (SUPPORT_CATEGORY_LABEL[str(r, 'category').toUpperCase()] ?? [str(r, 'category'), str(r, 'category')])[lang === 'ko' ? 0 : 1] },
            { key: 'contextType', label: L('관련', 'About'), hideOnMobile: true, render: (r) => (str(r, 'contextType') ? subjectLabel(str(r, 'contextType'), lang) : '—') },
            { key: 'status|state', label: L('상태', 'Status'), kind: 'status' },
            { key: 'createdAt', label: L('접수일', 'Opened'), kind: 'datetime' },
          ]}
        />
      )}
    </StateView>
  );
}

export default function SupportView() {
  const { L, lang } = useI18n();
  const [k, setK] = useState(0);
  const i = lang === 'ko' ? 0 : 1;
  return (
    <>
      <PageHeader
        title={L('고객센터', 'Help center')}
        subtitle={L('자주 묻는 질문을 확인하거나 1:1 문의를 남겨 주세요.', 'Browse common questions or send us a request.')}
        actions={
          <>
            <ButtonLink icon="flag" href="/support/disputes">{L('분쟁·안전 신고', 'Disputes & safety')}</ButtonLink>
            <ButtonLink icon="sparkle" href="/assistant">{L('AI 도우미', 'AI assistant')}</ButtonLink>
          </>
        }
      />
      <Section title={L('자주 묻는 질문', 'Frequently asked')}>
        <div className={s.faq}>
          {FAQ.map((f) => (
            <details key={f.q[0]}>
              <summary>
                <span>{f.q[i]}</span>
                <Icon name="down" size={18} />
              </summary>
              <p>{f.a[i]}</p>
            </details>
          ))}
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          {L('긴급한 안전 문제인가요? ', 'Urgent safety issue? ')}
          <Link href="/support/disputes">{L('안전 신고로 바로 접수하세요', 'Report it right away')}</Link>
          {L(' · 위급한 상황에서는 112/119에 먼저 연락하세요.', ' · In an emergency call local services first.')}
        </p>
      </Section>
      <RequireAuth>
        <Section title={L('1:1 문의하기', 'Contact us')}>
          <ContactForm onSent={() => setK((x) => x + 1)} />
        </Section>
        <Section title={L('내 문의', 'My requests')}>
          <MyCases key={k} />
        </Section>
      </RequireAuth>
    </>
  );
}
