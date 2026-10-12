import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: '메인 첫 페이지 관리',
  description: '관리자 콘솔 — 메인 첫 페이지 편집',
  alternates: { canonical: '/admin/home' },
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
