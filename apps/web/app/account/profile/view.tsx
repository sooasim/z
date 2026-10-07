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
          { name: 'phone', label: L('휴대폰', 'Phone'), type: 'tel' },
          { name: 'avatarUrl', label: L('프로필 사진 URL', 'Avatar URL'), type: 'url' },
          { name: 'homeCity', label: L('거주 도시', 'Home city') },
          { name: 'languages', label: L('사용 언어 (쉼표 구분)', 'Languages (comma separated)'), type: 'list', placeholder: 'ko, en' },
          { name: 'bio', label: L('자기소개', 'About me'), type: 'textarea' },
        ]}
      />
    </RequireAuth>
  );
}
