'use client';
import { useI18n } from '@/lib/i18n';
import { RequireAuth } from '@/components/gate';
import { ResourceForm } from '@/components/form';
import { PageHeader } from '@/components/ui';

export default function ProfileView() {
  const { L } = useI18n();
  return (
    <RequireAuth>
      <PageHeader title={L('프로필', 'Profile')} subtitle={L('프로필은 호스트·게스트·가이드 화면에 함께 표시됩니다. 변경 이력은 감사 기록됩니다.', 'Shown across host, guest and guide views. Changes are audited.')} />
      <ResourceForm
        path="/v1/me/profile"
        method="PATCH"
        cols={2}
        fields={[
          { name: 'displayName', label: L('표시 이름', 'Display name'), required: true },
          { name: 'preferredName', label: L('불리고 싶은 이름', 'Preferred name') },
          { name: 'phone', label: L('휴대폰 (+821012345678)', 'Phone (+821012345678)'), type: 'tel', placeholder: '+821012345678' },
          { name: 'country', label: L('국가 코드', 'Country'), placeholder: 'KR' },
          { name: 'timezone', label: L('시간대', 'Time zone'), placeholder: 'Asia/Seoul' },
          { name: 'languages', label: L('사용 언어 코드 (쉼표 구분)', 'Language codes (comma separated)'), type: 'list', placeholder: 'ko, en' },
          { name: 'bio', label: L('자기소개', 'About me'), type: 'textarea' },
        ]}
      />
    </RequireAuth>
  );
}
