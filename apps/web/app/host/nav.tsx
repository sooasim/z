'use client';
import { SideNav } from '@/components/shell';
import { useI18n } from '@/lib/i18n';

export function HostNav() {
  const { L } = useI18n();
  return (
    <SideNav
      label={L('호스트 메뉴', 'Host')}
      items={[
        { href: '/host/dashboard', label: L('대시보드', 'Dashboard'), icon: 'chart', group: L('호스트', 'Host') },
        { href: '/host/listings', label: L('숙소 관리', 'Listings'), icon: 'home' },
        { href: '/host/calendar', label: L('달력', 'Calendar'), icon: 'calendar' },
        { href: '/host/reservations', label: L('예약 관리', 'Reservations'), icon: 'bag' },
        { href: '/earnings', label: L('정산', 'Earnings'), icon: 'coin' },
        { href: '/host/integrations', label: L('연동 (PMS/iCal)', 'Integrations'), icon: 'settings', group: L('설정', 'Settings') },
        { href: '/host/onboarding', label: L('호스트 인증', 'Host verification'), icon: 'shield' },
        { href: '/messages', label: L('메시지', 'Messages'), icon: 'chat' },
      ]}
    />
  );
}
