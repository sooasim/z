'use client';
import { usePathname, useRouter } from 'next/navigation';
import { SideNav } from '@/components/shell';
import { useI18n } from '@/lib/i18n';
import type { IconName } from '@/components/ui';
import { styles as s } from '@/components/traveler/ui';

export function AccountNav() {
  const { L } = useI18n();
  const path = usePathname() || '';
  const router = useRouter();
  const items: Array<{ href: string; label: string; icon: IconName; group: string }> = [
    { href: '/account', label: L('개요', 'Overview'), icon: 'user', group: L('계정', 'Account') },
    { href: '/account/profile', label: L('프로필', 'Profile'), icon: 'edit', group: L('계정', 'Account') },
    { href: '/account/preferences', label: L('환경설정', 'Preferences'), icon: 'settings', group: L('계정', 'Account') },
    { href: '/account/security', label: L('보안·로그인', 'Security'), icon: 'shield', group: L('보안·개인정보', 'Security & privacy') },
    { href: '/account/privacy', label: L('개인정보·동의', 'Privacy & consent'), icon: 'lock', group: L('보안·개인정보', 'Security & privacy') },
    { href: '/verification', label: L('본인·사업자 인증', 'Verification'), icon: 'verified', group: L('보안·개인정보', 'Security & privacy') },
    { href: '/account/notifications', label: L('알림 설정', 'Notifications'), icon: 'bell', group: L('활동', 'Activity') },
    { href: '/account/reviews', label: L('내 후기', 'My reviews'), icon: 'star', group: L('활동', 'Activity') },
    { href: '/payments', label: L('결제 내역', 'Payments'), icon: 'card', group: L('활동', 'Activity') },
    { href: '/saved', label: L('저장 목록', 'Saved'), icon: 'heart', group: L('활동', 'Activity') },
  ];
  const current = items.find((i) => i.href === path) ?? items.filter((i) => i.href !== '/account' && path.startsWith(i.href)).sort((a, b) => b.href.length - a.href.length)[0] ?? items[0];
  return (
    <div>
      {/* Phones: one compact select instead of a clipped horizontal strip of 10 pills. */}
      <label className={`field ${s.accountNavSelect}`}>
        <span>{L('계정 메뉴', 'Account menu')}</span>
        <select value={current.href} onChange={(e) => router.push(e.target.value)}>
          {items.map((i) => (
            <option key={i.href} value={i.href}>
              {i.label}
            </option>
          ))}
        </select>
      </label>
      <div className={s.accountNavStrip}>
        <SideNav label={L('계정 메뉴', 'Account')} items={items} />
      </div>
    </div>
  );
}
