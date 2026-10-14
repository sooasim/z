import type { Metadata } from 'next';
import { Suspense } from 'react';
import View from './view';

export const metadata: Metadata = {
  title: "주문 접수",
  description: "관리자 콘솔 — 여행 상품 주문 접수와 처리",
  alternates: { canonical: '/admin/travel/orders' },
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
