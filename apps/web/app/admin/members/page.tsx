import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "회원 관리",
  description: "관리자 콘솔 — 회원 조회, 역할, 계정 정지",
  alternates: { canonical: '/admin/members' },
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
