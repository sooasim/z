'use client';
import { SideNav } from '@/components/shell';
import { useI18n } from '@/lib/i18n';

export function AccountNav() {
  const { L } = useI18n();
  return (
    <SideNav
      label={L('계정 메뉴', 'Account')}
      items={[
        { href: '/account', label: L('개요', 'Overview') },
        { href: '/account/profile', label: L('프로필', 'Profile') },
        { href: '/account/preferences', label: L('환경설정', 'Preferences') },
        { href: '/account/security', label: L('보안·MFA', 'Security & MFA') },
        { href: '/account/notifications', label: L('알림 설정', 'Notifications') },
        { href: '/account/privacy', label: L('개인정보·동의', 'Privacy & consent') },
        { href: '/account/reviews', label: L('내 후기', 'My reviews') },
        { href: '/verification', label: L('본인·사업자 인증', 'Verification') },
        { href: '/payments', label: L('결제 내역', 'Payments') },
        { href: '/saved', label: L('저장 목록', 'Saved') },
      ]}
    />
  );
}
