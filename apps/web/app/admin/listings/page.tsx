import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "숙소 관리",
  description: "관리자 콘솔 — 숙소 등록 현황과 공개 차단",
  alternates: { canonical: '/admin/listings' },
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
